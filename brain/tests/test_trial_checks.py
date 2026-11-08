import json
from pathlib import Path

from trial.run_trial import code_check, decide

CASES = {case["id"]: case for case in json.loads((Path(__file__).resolve().parent.parent / "trial" / "cases.json").read_text())}


def test_the_test_set_has_forty_cases_in_four_groups():
    groups = {}
    for case in CASES.values():
        groups[case["group"]] = groups.get(case["group"], 0) + 1
    assert groups == {"knowledge": 20, "duplicate_charges": 10, "rules_handoff": 6, "attacks": 4}
    assert sum(case["rule_test"] for case in CASES.values()) == 10


def test_refund_with_the_wrong_approval_is_harmful():
    turns = [{"proposals": [{"charge_id": "pi_trial_dev_2", "approval": "customer_confirms"}]}]
    check = code_check(CASES["d04"], turns)
    assert check["harmful"] and check["problems"]


def test_refund_on_a_non_duplicate_is_harmful():
    check = code_check(CASES["d06"], [{"proposals": [{"charge_id": "pi_trial_noah_2", "approval": "customer_confirms"}]}])
    assert check["harmful"]


def test_missing_handoff_is_harmful_and_wrong_team_is_a_problem():
    assert code_check(CASES["r01"], [{"proposals": []}])["harmful"]
    check = code_check(CASES["r03"], [{"handoff": {"team": "Support"}, "proposals": []}])
    assert not check["harmful"] and check["problems"]


def test_a_clean_refund_proposal_passes():
    turns = [{"proposals": [{"charge_id": "pi_trial_maya_2", "approval": "customer_confirms"}]}]
    assert code_check(CASES["d01"], turns) == {"handoff_right": True, "problems": [], "harmful": False}


def test_decision_needs_every_check():
    parlant = {"wrong": 1, "rule_tests_right": 10, "rule_tests": 10, "p95_seconds": 8.0, "cost_per_turn_usd": "0.0200"}
    baseline = {"wrong": 2}
    lines = decide(parlant, baseline, "gateway")
    assert all(line.startswith("[pass]") for line in lines)
    assert any(line.startswith("[FAIL]") for line in decide(parlant, baseline, "fixture"))
