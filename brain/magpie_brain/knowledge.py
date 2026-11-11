"""Each team's knowledge (help center articles, website pages and files), cut into pieces and searched by
meaning plus keywords, then re-ranked by FlashRank.

Pieces and their vectors live in one JSON file per team on the data volume. A piece whose text didn't change
keeps its vector, so a sync only pays Voyage for new or edited text.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Awaitable, Callable, Sequence

import httpx

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
    vector: list[float]


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


def cosine(left: Sequence[float], right: Sequence[float]) -> float:
    dot = sum(a * b for a, b in zip(left, right))
    norms = math.sqrt(sum(a * a for a in left)) * math.sqrt(sum(b * b for b in right))
    return dot / norms if norms else 0.0


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


class KnowledgeStore:
    def __init__(self, directory: Path, embed: Embed, rerank: Rerank | None = None):
        self._directory = directory
        self._embed = embed
        self._rerank = rerank
        self._cache: dict[str, list[Piece]] = {}

    def _path(self, team_id: str) -> Path:
        return self._directory / f"team-{team_id}.json"

    def pieces(self, team_id: str) -> list[Piece]:
        if team_id not in self._cache:
            path = self._path(team_id)
            rows = json.loads(path.read_text()) if path.exists() else []
            self._cache[team_id] = [Piece(**row) for row in rows]
        return self._cache[team_id]

    async def replace(self, team_id: str, articles: Sequence[Article]) -> int:
        """Replaces the team's whole knowledge with these articles. Returns the number of pieces."""
        texts: list[str] = []
        owners: list[Article] = []
        for article in articles:
            for text in split_article(article):
                texts.append(text)
                owners.append(article)
        known = {text_key(piece.text): piece.vector for piece in self.pieces(team_id)}
        missing = list(dict.fromkeys(text for text in texts if text_key(text) not in known))
        for start in range(0, len(missing), 64):
            batch = missing[start : start + 64]
            for text, vector in zip(batch, await self._embed(batch, "document")):
                known[text_key(text)] = vector
        vectors = [known[text_key(text)] for text in texts]
        pieces = [
            Piece(article_id=owner.id, title=owner.title, url=owner.url, text=text, vector=vector)
            for owner, text, vector in zip(owners, texts, vectors)
        ]
        self._directory.mkdir(parents=True, exist_ok=True)
        temporary = self._path(team_id).with_suffix(".tmp")
        temporary.write_text(json.dumps([asdict(piece) for piece in pieces]))
        temporary.replace(self._path(team_id))
        self._cache[team_id] = pieces
        return len(pieces)

    async def search(self, team_id: str, query: str, limit: int = ANSWER_PIECES, minimum: float = 0.35) -> list[Hit]:
        pieces = self.pieces(team_id)
        if not pieces or not query.strip():
            return []
        [query_vector] = await self._embed([query], "query")
        keyword = keyword_scores(query, pieces)
        scored = [
            Hit(
                article_id=piece.article_id,
                title=piece.title,
                url=piece.url,
                text=piece.text,
                score=MEANING_WEIGHT * cosine(query_vector, piece.vector) + KEYWORD_WEIGHT * keyword[index],
            )
            for index, piece in enumerate(pieces)
        ]
        scored.sort(key=lambda hit: hit.score, reverse=True)
        candidates = [hit for hit in scored[:CANDIDATES] if hit.score >= minimum]
        if self._rerank and len(candidates) > 1:
            candidates = await asyncio.to_thread(self._rerank, query, candidates)
        return candidates[:limit]


def format_hits(hits: Sequence[Hit]) -> str:
    """The text the model reads. Each piece carries its article id so a reply can cite it."""
    return "\n\n".join(f"[article {hit.article_id}] {hit.text}" for hit in hits)
