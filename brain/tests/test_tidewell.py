"""Tests for the brain's own logic: articles, refund checks and Stripe lookups. No Parlant server
or Claude needed. The Parlant engine itself is exercised by the trial runner."""

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from stripe_gateway import DisconnectedGateway, GatewayCall, McpGateway, lookup_payments, parse_list, to_payment  # noqa: E402
from tidewell import articles_text, check_refund, describe_payments  # noqa: E402

PAYMENTS = [
    {"id": "pi_1", "amount_cents": 2400, "date": "2026-11-05", "description": "Order TW-10418", "metadata": {}, "status": "succeeded"},
    {"id": "pi_big", "amount_cents": 8900, "date": "2026-11-05", "description": "Order TW-10425", "metadata": {}, "status": "succeeded"},
]


class FakeGateway:
    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    async def call(self, calls):
        self.calls.extend(calls)
        return [GatewayCall(f"stripe-{kind}", arguments, *self.answers[kind]) for kind, arguments in calls]


def test_reads_all_29_articles_with_their_titles():
    text = articles_text()
    assert text.count("<article ") == 29
    assert '<article slug="where-we-ship" title="Where we ship and what it costs">' in text


def test_refund_requests_go_to_the_customer_under_50_and_to_staff_from_50():
    data, request = check_refund("pi_1", PAYMENTS, None, [])
    assert request == {"payment_id": "pi_1", "amount_cents": 2400, "gate": "customer_confirm", "label": "$24.00 for Order TW-10418 on 2026-11-05"}
    assert "Confirm and Cancel" in data

    data, request = check_refund("pi_big", PAYMENTS, None, [])
    assert request["gate"] == "staff_approval"
    assert "staff" in data


@pytest.mark.parametrize(
    ("payment_id", "pending", "refunded", "message"),
    [
        ("pi_made_up", None, [], "Unknown charge"),
        ("pi_1", None, ["pi_1"], "already refunded"),
        ("pi_1", {"payment_id": "pi_big"}, [], "already waiting"),
    ],
)
def test_refund_requests_are_refused_for_unknown_refunded_or_while_one_waits(payment_id, pending, refunded, message):
    data, request = check_refund(payment_id, PAYMENTS, pending, refunded)
    assert request is None
    assert message in data


def test_reads_stripe_lists_and_payments():
    assert parse_list('{"data": [{"id": "cus_1"}]}') == [{"id": "cus_1"}]
    assert parse_list("not json") == []
    payment = to_payment({"id": "pi_1", "amount": 2400, "created": 1793750400, "description": "Order TW-1", "metadata": {"order": "TW-1"}, "status": "succeeded"})
    assert (payment.date, payment.metadata) == ("2026-11-04", {"order": "TW-1"})
    rows = json.loads(describe_payments([payment], refunded=["pi_1"]))
    assert rows == [{"id": "pi_1", "amount": "$24.00", "date": "2026-11-04", "description": "Order TW-1", "order": "TW-1", "status": "succeeded", "refunded_here": True}]


async def test_looks_up_the_customer_by_email_then_their_payments():
    gateway = FakeGateway(
        {
            "list-customers": (True, '[{"id": "cus_9"}]'),
            "list-payment-intents": (True, '{"data": [{"id": "pi_1", "amount": 2400}]}'),
        }
    )
    found = await lookup_payments(gateway, "maya.alvarez@example.com")
    assert gateway.calls == [("list-customers", {"email": "maya.alvarez@example.com", "limit": 1}), ("list-payment-intents", {"customer": "cus_9", "limit": 20})]
    assert [payment.id for payment in found.payments] == ["pi_1"]
    assert found.reached


async def test_a_customer_stripe_doesnt_know_has_no_payments_and_a_failure_is_reported():
    unknown = await lookup_payments(FakeGateway({"list-customers": (True, "[]")}), "nobody@example.com")
    assert (unknown.payments, unknown.reached, len(unknown.calls)) == ([], True, 1)

    disconnected = await lookup_payments(DisconnectedGateway(), "maya.alvarez@example.com")
    assert not disconnected.reached
    assert disconnected.calls[0].name == "stripe-list-customers"
    assert not disconnected.calls[0].ok


@pytest.mark.skipif(not os.environ.get("TEST_GATEWAY_MCP_URL"), reason="needs a gateway server (TEST_GATEWAY_MCP_URL, TEST_GATEWAY_TOKEN)")
async def test_reaches_stripe_through_a_real_gateway():
    gateway = McpGateway(os.environ["TEST_GATEWAY_MCP_URL"], os.environ["TEST_GATEWAY_TOKEN"])
    found = await lookup_payments(gateway, "maya.alvarez@example.com")
    assert found.reached
    assert [call.name for call in found.calls] == ["stripe-list-customers", "stripe-list-payment-intents"]
    assert found.payments
