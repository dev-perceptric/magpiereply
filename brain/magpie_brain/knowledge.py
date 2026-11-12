"""Each team's knowledge (help center articles, website pages and files), cut into pieces and searched by
meaning plus keywords, then re-ranked by FlashRank.

Each team's pieces and their vectors live in one .npz file on the data volume, the vectors as one float32 array
(about 4 KB a piece; plain Python lists took about 32 KB). A piece whose text didn't change keeps its vector, so a
sync only pays Voyage for new or edited text. A team's file from before (JSON with the vectors inside) is converted
the first time it's read.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import math
import re
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Awaitable, Callable, Sequence

import httpx
import numpy as np

VOYAGE_URL = "https://api.voyageai.com/v1/embeddings"
VOYAGE_MODEL = "voyage-3.5"
PIECE_TARGET_CHARS = 900
# Meaning decides; matching words only nudge. In the phase 0 trial, a heavier keyword share let words like
# "you" and "hours" pull Tracking above Contacting us.
MEANING_WEIGHT = 1.0
KEYWORD_WEIGHT = 0.15
STOPWORDS = frozenset(
    "a an and are as at be but by can could did do does for from had has have how i if in is it its me my no not "
    "of on or our please so that the them then there they this to was we were what when where which who why will "
    "with would you your yours".split()
)

# How many pieces hybrid search hands to the re-ranker, and how many the model reads.
CANDIDATES = 12
ANSWER_PIECES = 4

# Takes texts and whether they are documents or a query, returns one vector per text.
Embed = Callable[[Sequence[str], str], Awaitable[list[list[float]]]]
# Takes the query and the candidate pieces, returns them best first.
Rerank = Callable[[str, list["Hit"]], list["Hit"]]


@dataclass
class Article:
    id: str
    title: str
    body: str
    url: str | None = None


@dataclass
class Piece:
    article_id: str
    title: str
    url: str | None
    text: str


@dataclass
class Hit:
    article_id: str
    title: str
    url: str | None
    text: str
    score: float


def voyage_embedder(api_key: str) -> Embed:
    async def embed(texts: Sequence[str], input_type: str) -> list[list[float]]:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                VOYAGE_URL,
                headers={"authorization": f"Bearer {api_key}"},
                json={"input": list(texts), "model": VOYAGE_MODEL, "input_type": input_type},
            )
            response.raise_for_status()
            rows = sorted(response.json()["data"], key=lambda row: row["index"])
            return [row["embedding"] for row in rows]

    return embed


def split_article(article: Article) -> list[str]:
    """Cuts an article into pieces of about PIECE_TARGET_CHARS, on paragraph breaks."""
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", article.body) if part.strip()]
    pieces: list[str] = []
    current = ""
    for paragraph in paragraphs:
        if current and len(current) + len(paragraph) > PIECE_TARGET_CHARS:
            pieces.append(current)
            current = ""
        current = f"{current}\n\n{paragraph}" if current else paragraph
    if current:
        pieces.append(current)
    return [f"{article.title}\n\n{piece}" for piece in pieces]


def words(text: str) -> list[str]:
    return [word for word in re.findall(r"[a-z0-9]+", text.lower()) if word not in STOPWORDS]


def keyword_scores(query: str, pieces: Sequence[Piece]) -> list[float]:
    """BM25 over the team's pieces, scaled so the best piece scores 1."""
    query_words = set(words(query))
    if not query_words or not pieces:
        return [0.0 for _ in pieces]
    piece_words = [words(piece.text) for piece in pieces]
    average_length = sum(len(found) for found in piece_words) / len(piece_words)
    document_frequency = Counter(word for found in piece_words for word in set(found))
    total = len(pieces)
    scores = []
    for found in piece_words:
        counts = Counter(found)
        score = 0.0
        for word in query_words:
            if word not in counts:
                continue
            idf = math.log(1 + (total - document_frequency[word] + 0.5) / (document_frequency[word] + 0.5))
            frequency = counts[word]
            score += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * len(found) / average_length))
        scores.append(score)
    best = max(scores)
    return [score / best if best else 0.0 for score in scores]


def flashrank_reranker(model_name: str, cache_dir: str) -> Rerank:
    """Re-ranks with a small cross-encoder that runs on the CPU (FlashRank). The model is baked into the image."""
    from flashrank import Ranker, RerankRequest

    ranker = Ranker(model_name=model_name, cache_dir=cache_dir)

    def rerank(query: str, hits: list[Hit]) -> list[Hit]:
        passages = [{"id": index, "text": hit.text} for index, hit in enumerate(hits)]
        ranked = ranker.rerank(RerankRequest(query=query, passages=passages))
        return [hits[row["id"]] for row in ranked]

    return rerank


def text_key(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def normalized(vectors: Sequence[Sequence[float]]) -> np.ndarray:
    """Rows of unit length as float32, so a dot product is the cosine. An empty or zero row stays zero."""
    matrix = np.asarray(vectors, dtype=np.float32)
    if matrix.ndim != 2 or len(matrix) == 0:
        return np.zeros((len(vectors), 0), dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return np.divide(matrix, norms, out=np.zeros_like(matrix), where=norms > 0)


class TeamKnowledge:
    def __init__(self, pieces: list[Piece], vectors: np.ndarray):
        self.pieces = pieces
        self.vectors = vectors


class KnowledgeStore:
    def __init__(self, directory: Path, embed: Embed, rerank: Rerank | None = None):
        self._directory = directory
        self._embed = embed
        self._rerank = rerank
        self._cache: dict[str, TeamKnowledge] = {}

    def _path(self, team_id: str) -> Path:
        return self._directory / f"team-{team_id}.npz"

    def _load(self, team_id: str) -> TeamKnowledge:
        path = self._path(team_id)
        if path.exists():
            with np.load(path) as stored:
                rows = json.loads(stored["pieces"].tobytes().decode())
                return TeamKnowledge([Piece(**row) for row in rows], stored["vectors"])
        old = self._directory / f"team-{team_id}.json"
        if not old.exists():
            return TeamKnowledge([], np.zeros((0, 0), dtype=np.float32))
        rows = json.loads(old.read_text())
        knowledge = TeamKnowledge(
            [Piece(**{key: row[key] for key in ("article_id", "title", "url", "text")}) for row in rows],
            normalized([row["vector"] for row in rows]),
        )
        self._save(team_id, knowledge)
        old.unlink()
        return knowledge

    def _save(self, team_id: str, knowledge: TeamKnowledge) -> None:
        self._directory.mkdir(parents=True, exist_ok=True)
        buffer = io.BytesIO()
        pieces = np.frombuffer(json.dumps([asdict(piece) for piece in knowledge.pieces]).encode(), dtype=np.uint8)
        np.savez(buffer, pieces=pieces, vectors=knowledge.vectors)
        temporary = self._path(team_id).with_suffix(".tmp")
        temporary.write_bytes(buffer.getvalue())
        temporary.replace(self._path(team_id))

    def knowledge(self, team_id: str) -> TeamKnowledge:
        if team_id not in self._cache:
            self._cache[team_id] = self._load(team_id)
        return self._cache[team_id]

    def pieces(self, team_id: str) -> list[Piece]:
        return self.knowledge(team_id).pieces

    async def replace(self, team_id: str, articles: Sequence[Article]) -> int:
        """Replaces the team's whole knowledge with these articles. Returns the number of pieces."""
        texts: list[str] = []
        owners: list[Article] = []
        for article in articles:
            for text in split_article(article):
                texts.append(text)
                owners.append(article)
        current = self.knowledge(team_id)
        known = {text_key(piece.text): current.vectors[index] for index, piece in enumerate(current.pieces)}
        missing = list(dict.fromkeys(text for text in texts if text_key(text) not in known))
        for start in range(0, len(missing), 64):
            batch = missing[start : start + 64]
            for text, vector in zip(batch, normalized(await self._embed(batch, "document"))):
                known[text_key(text)] = vector
        pieces = [Piece(article_id=owner.id, title=owner.title, url=owner.url, text=text) for owner, text in zip(owners, texts)]
        vectors = np.stack([known[text_key(text)] for text in texts]) if texts else np.zeros((0, 0), dtype=np.float32)
        knowledge = TeamKnowledge(pieces, vectors.astype(np.float32))
        self._save(team_id, knowledge)
        self._cache[team_id] = knowledge
        return len(pieces)

    async def search(self, team_id: str, query: str, limit: int = ANSWER_PIECES, minimum: float = 0.35) -> list[Hit]:
        knowledge = self.knowledge(team_id)
        if not knowledge.pieces or not query.strip():
            return []
        [query_vector] = normalized(await self._embed([query], "query"))
        meaning = knowledge.vectors @ query_vector
        keyword = keyword_scores(query, knowledge.pieces)
        scored = [
            Hit(
                article_id=piece.article_id,
                title=piece.title,
                url=piece.url,
                text=piece.text,
                score=float(MEANING_WEIGHT * meaning[index] + KEYWORD_WEIGHT * keyword[index]),
            )
            for index, piece in enumerate(knowledge.pieces)
        ]
        scored.sort(key=lambda hit: hit.score, reverse=True)
        candidates = [hit for hit in scored[:CANDIDATES] if hit.score >= minimum]
        if self._rerank and len(candidates) > 1:
            candidates = await asyncio.to_thread(self._rerank, query, candidates)
        return candidates[:limit]


def format_hits(hits: Sequence[Hit]) -> str:
    """The text the model reads. Each piece carries its article id so a reply can cite it."""
    return "\n\n".join(f"[article {hit.article_id}] {hit.text}" for hit in hits)
