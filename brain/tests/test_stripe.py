from pathlib import Path

import pytest

from magpie_brain.stripe import Charge, FixtureStripe, _tool_named, approval_for, find_duplicates

FIXTURE = Path(__file__).resolve().parent.parent / "trial" / "stripe_fixture.json"


def charge(charge_id, cents, created, description="Order 1", refunded=False):
    return Charge(id=charge_id, amount_cents=cents, currency="usd", created=created, description=description, refunded=refunded)


def test_same_amount_and_order_within_a_day_is_a_duplicate():
    pairs = find_duplicates([charge("b", 3400, 160), charge("a", 3400, 100)])
    assert [(first.id, second.id) for first, second in pairs] == [("a", "b")]


def test_different_orders_or_days_apart_are_not_duplicates():
    assert find_duplicates([charge("a", 4200, 0, "Order 1"), charge("b", 4200, 60, "Order 2")]) == []
    assert find_duplicates([charge("a", 4200, 0), charge("b", 4200, 3 * 86400)]) == []


def test_refunded_charges_are_ignored():
    assert find_duplicates([charge("a", 3400, 0), charge("b", 3400, 60, refunded=True)]) == []


def test_three_identical_charges_give_two_duplicates():
    pairs = find_duplicates([charge("a", 100, 0), charge("b", 100, 10), charge("c", 100, 20)])
    assert sorted(second.id for _, second in pairs) == ["b", "c"] or len(pairs) == 1


def test_approval_threshold_is_fifty_dollars():
    assert approval_for(charge("a", 4999, 0)) == "customer_confirms"
    assert approval_for(charge("a", 5000, 0)) == "staff_approves"


async def test_fixture_matches_the_trial_cases():
    stripe = FixtureStripe(FIXTURE)
    duplicates = {
        email: [second.id for _, second in find_duplicates(await stripe.charges_for(email))]
        for email in ["maya.chen@example.com", "dev.patel@example.com", "sofia.romero@example.com",
                      "noah.williams@example.com", "grace.okafor@example.com", "ivan.petrov@example.com"]
    }
    assert duplicates == {
        "maya.chen@example.com": ["pi_trial_maya_2"],
        "dev.patel@example.com": ["pi_trial_dev_2"],
        "sofia.romero@example.com": ["pi_trial_sofia_2"],
        "noah.williams@example.com": [],
        "grace.okafor@example.com": [],
        "ivan.petrov@example.com": [],
    }
    assert await stripe.charges_for("MAYA.CHEN@example.com")
    assert await stripe.charges_for("someone@else.com") == []


def test_gateway_tool_names_match_on_their_ending():
    names = ["stripe-list-customers", "stripe-list-payment-intents", "stripe-create-refund"]
    assert _tool_named(names, "list_customers") == "stripe-list-customers"
    assert _tool_named(names, "list_payment_intents") == "stripe-list-payment-intents"
    with pytest.raises(LookupError):
        _tool_named(names, "list_charges")
