from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest

from magpie_brain.engine import Customer, Message, ReplyRequest, cost_of, run_reply
from magpie_brain.knowledge import Article, KnowledgeStore
from magpie_brain.stripe import FixtureStripe

FIXTURE = Path(__file__).resolve().parent.parent / "trial" / "stripe_fixture.json"


async def no_vectors(texts, input_type):
    return [[1.0] for _ in texts]


def block(kind, **fields):
    return SimpleNamespace(type=kind, model_dump=lambda: {"type": kind, **fields}, **fields)


class ScriptedClaude:
    """Plays back fixed model answers and records what it was sent."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = []
        self.messages = self

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        content = self.answers.pop(0)
        return SimpleNamespace(content=content, usage=SimpleNamespace(input_tokens=1000, output_tokens=100, cache_read_input_tokens=0, cache_creation_input_tokens=0))


def request(email="maya.chen@example.com", verified=True, text="I was charged twice"):
    return ReplyRequest(
        team_id="t1",
        customer=Customer(id="9", name="Maya", email=email, verified=verified),
        history=[Message(role="customer", content=text)],
    )


@pytest.fixture
def knowledge(tmp_path):
    return KnowledgeStore(tmp_path, no_vectors)


async def test_a_duplicate_charge_becomes_a_refund_proposal(knowledge):
    claude = ScriptedClaude([
        [block("tool_use", id="c1", name="list_recent_charges", input={})],
        [block("tool_use", id="c2", name="propose_refund", input={"charge_id": "pi_trial_maya_2"})],
        [block("text", text="Shall I refund the duplicate $34.00?")],
    ])
    out = await run_reply(request(), knowledge, FixtureStripe(FIXTURE), claude, "claude-sonnet-5-5")
    assert out["reply"] == "Shall I refund the duplicate $34.00?"
    assert out["proposals"] == [{"action": "refund", "charge_id": "pi_trial_maya_2", "amount": "34.00 USD", "approval": "customer_confirms"}]
    assert [tool["name"] for tool in out["tools"]] == ["list_recent_charges", "propose_refund"]
    assert out["cost_usd"] == "0.00900"  # 3 calls of 1,000 tokens in and 100 out on Sonnet


async def test_tools_refuse_a_customer_who_is_not_signed_in(knowledge):
    claude = ScriptedClaude([
        [block("tool_use", id="c1", name="list_recent_charges", input={})],
        [block("text", text="Please sign in first.")],
    ])
    out = await run_reply(request(verified=False), knowledge, FixtureStripe(FIXTURE), claude, "claude-sonnet-5-5")
    assert out["tools"][0]["refused"] == "not_verified"
    assert out["proposals"] == []
    assert "not signed in" in claude.calls[0]["system"][1]["text"]


async def test_a_refund_for_a_charge_that_is_not_a_duplicate_is_refused(knowledge):
    claude = ScriptedClaude([
        [block("tool_use", id="c1", name="propose_refund", input={"charge_id": "pi_trial_maya_0"})],
        [block("text", text="That charge isn't a duplicate.")],
    ])
    out = await run_reply(request(), knowledge, FixtureStripe(FIXTURE), claude, "claude-sonnet-5-5")
    assert out["tools"][0]["refused"] == "not_a_duplicate"
    assert out["proposals"] == []


async def test_handoff_and_articles_reach_the_model(knowledge):
    await knowledge.replace("t1", [Article(id="hours", title="Contacting us", body="We answer Monday to Friday.")])
    claude = ScriptedClaude([
        [block("tool_use", id="c1", name="transfer_to_human", input={"team": "Billing", "reason": "chargeback"})],
        [block("text", text="Passing you to Billing.")],
    ])
    out = await run_reply(request(text="when are you open"), knowledge, FixtureStripe(FIXTURE), claude, "claude-sonnet-5-5")
    assert out["handoff"] == {"team": "Billing", "reason": "chargeback"}
    assert "[article hours]" in claude.calls[0]["system"][1]["text"]
    assert claude.calls[0]["system"][0]["cache_control"] == {"type": "ephemeral"}


def test_cache_writes_cost_a_quarter_more_than_input():
    usage = SimpleNamespace(input_tokens=0, output_tokens=0, cache_read_input_tokens=0, cache_creation_input_tokens=1_000_000)
    assert cost_of("claude-sonnet-5-5", usage) == Decimal("2.5")


async def test_the_sources_line_becomes_the_articles_magpie_read(knowledge):
    await knowledge.replace("t1", [Article(id="12", title="Shipping to Canada", body="We ship to Canada in 5 days.", url="https://help.example.com/a/12")])
    claude = ScriptedClaude([[block("text", text="Yes, we ship to Canada in 5 days.\n\nSources: 12, 99")]])
    out = await run_reply(request(text="do you ship to canada"), knowledge, FixtureStripe(FIXTURE), claude, "claude-sonnet-5-5")
    assert out["reply"] == "Yes, we ship to Canada in 5 days."
    assert out["sources"] == [{"id": "12", "title": "Shipping to Canada", "url": "https://help.example.com/a/12"}]
    assert out["check"] is None  # no review model, no check


async def test_the_review_flags_what_the_articles_do_not_support(knowledge):
    await knowledge.replace("t1", [Article(id="12", title="Shipping to Canada", body="We ship to Canada in 5 days.")])
    claude = ScriptedClaude([
        [block("text", text="We ship to Canada in 2 days, for free.\n\nSources: 12")],
        [block("tool_use", id="r1", name="report", input={"unsupported": ["in 2 days", "for free"], "handoff_note": ""})],
    ])
    out = await run_reply(request(text="do you ship to canada"), knowledge, FixtureStripe(FIXTURE), claude, "claude-sonnet-5-5", "claude-haiku-5-5")
    assert out["check"] == {"passed": False, "unsupported": ["in 2 days", "for free"]}
    assert out["handoff_note"] is None
    review = claude.calls[1]
    assert review["model"] == "claude-haiku-5-5"
    assert review["tool_choice"] == {"type": "tool", "name": "report"}
    assert "We ship to Canada in 5 days." in review["messages"][0]["content"]
    # Sonnet: 1,000 in and 100 out is $0.003. Haiku: 1,000 in and 100 out is $0.00015.
    assert out["cost_usd"] == "0.00315"


async def test_a_handoff_gets_a_note_for_the_person_taking_over(knowledge):
    claude = ScriptedClaude([
        [block("tool_use", id="c1", name="transfer_to_human", input={"team": "Billing", "reason": "chargeback"})],
        [block("text", text="I'm passing you to our billing team.\n\nSources: none")],
        [block("tool_use", id="r1", name="report", input={"unsupported": [], "handoff_note": "Maya wants to reverse a charge. Nothing looked up yet."})],
    ])
    out = await run_reply(request(text="I'll file a chargeback"), knowledge, FixtureStripe(FIXTURE), claude, "claude-sonnet-5-5", "claude-haiku-5-5")
    assert out["check"] == {"passed": True, "unsupported": []}
    assert out["handoff_note"] == "Maya wants to reverse a charge. Nothing looked up yet."
    assert out["sources"] == []
    assert "Handoff to Billing: chargeback" in claude.calls[2]["messages"][0]["content"]
