import json
from pathlib import Path

from magpie_brain.knowledge import Article, KnowledgeStore, keyword_scores, split_article, Piece

ARTICLES = json.loads((Path(__file__).resolve().parent.parent / "trial" / "articles.json").read_text())


def fake_embed_factory():
    """Vectors from word counts over a fixed vocabulary: enough to test ranking without Voyage."""
    vocabulary = ["canada", "ship", "shipping", "email", "password", "candle", "refund", "linen", "gift", "box"]

    async def embed(texts, input_type):
        return [[float(text.lower().count(word)) for word in vocabulary] for text in texts]

    return embed


def test_split_article_keeps_title_and_breaks_on_paragraphs():
    article = Article(id="a", title="Title", body=("word " * 150 + "\n\n") * 4)
    pieces = split_article(article)
    assert len(pieces) >= 2
    assert all(piece.startswith("Title\n\n") for piece in pieces)


def test_keyword_scores_rank_the_matching_piece_first():
    pieces = [Piece("a", "A", None, "free shipping to canada", []), Piece("b", "B", None, "reset your password", [])]
    scores = keyword_scores("Do you ship to Canada?", pieces)
    assert scores[0] == 1.0 and scores[1] == 0.0


async def test_search_finds_the_canada_article(tmp_path):
    store = KnowledgeStore(tmp_path, fake_embed_factory())
    count = await store.replace("trial", [Article(**row) for row in ARTICLES])
    assert count >= len(ARTICLES)
    hits = await store.search("trial", "Do you ship to Canada?")
    assert hits[0].article_id == "shipping-canada"


async def test_search_is_per_team_and_survives_a_restart(tmp_path):
    store = KnowledgeStore(tmp_path, fake_embed_factory())
    await store.replace("one", [Article(id="x", title="Gift cards", body="Gift cards never expire.")])
    reopened = KnowledgeStore(tmp_path, fake_embed_factory())
    assert (await reopened.search("one", "do gift cards expire"))[0].article_id == "x"
    assert await reopened.search("two", "do gift cards expire") == []


def test_common_words_do_not_count_as_matches():
    pieces = [Piece("a", "A", None, "Tracking can take up to 24 hours. You can find it in your account.", []),
              Piece("b", "B", None, "Our team answers chat Monday to Friday.", [])]
    scores = keyword_scores("Can you tell me if you are open?", pieces)
    assert scores == [0.0, 0.0]


async def test_unchanged_pieces_keep_their_vectors(tmp_path):
    seen = []

    async def embed(texts, input_type):
        seen.append(list(texts))
        return [[1.0, float(len(text))] for text in texts]

    store = KnowledgeStore(tmp_path, embed)
    await store.replace("t", [Article(id="a", title="A", body="Alpha."), Article(id="b", title="B", body="Beta.")])
    await store.replace("t", [Article(id="a", title="A", body="Alpha."), Article(id="b", title="B", body="Beta, edited.")])
    assert seen == [["A\n\nAlpha.", "B\n\nBeta."], ["B\n\nBeta, edited."]]
    assert len(store.pieces("t")) == 2


async def test_the_reranker_orders_the_candidates(tmp_path):
    def reverse(query, hits):
        return list(reversed(hits))

    store = KnowledgeStore(tmp_path, fake_embed_factory(), reverse)
    await store.replace("t", [
        Article(id="ship", title="Shipping", body="We ship to Canada. Shipping to Canada takes 5 days."),
        Article(id="canada", title="Canada", body="Canada orders ship from Toronto."),
    ])
    plain = await KnowledgeStore(tmp_path, fake_embed_factory()).search("t", "ship to canada")
    reranked = await store.search("t", "ship to canada")
    assert [hit.article_id for hit in reranked] == [hit.article_id for hit in reversed(plain)]
