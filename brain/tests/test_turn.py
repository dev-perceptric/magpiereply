from magpie_brain.turn import TurnResult, add_usage, read_events, tool_name, turn_finished


def event(kind, source, offset, trace="t1", data=None):
    return {"kind": kind, "source": source, "offset": offset, "trace_id": trace, "data": data or {}}


def test_reads_replies_tools_proposals_and_handoff():
    events = [
        event("message", "customer", 0, data={"message": "charged twice"}),
        event("tool", "ai_agent", 1, data={"tool_calls": [
            {"tool_id": "built-in:list_recent_charges", "arguments": {}, "result": {"data": {"charges": []}}},
            {"tool_id": "built-in:propose_refund", "arguments": {"charge_id": "pi_2"},
             "result": {"data": {"proposal": {"charge_id": "pi_2", "approval": "customer_confirms"}}}},
        ]}),
        event("message", "ai_agent", 2, data={"message": "Shall I refund it?"}),
        event("status", "ai_agent", 3, data={"status": "ready"}),
    ]
    result = TurnResult(session_id="s")
    read_events(result, events)
    assert result.replies == ["Shall I refund it?"]
    assert [tool["name"] for tool in result.tools] == ["list_recent_charges", "propose_refund"]
    assert result.proposals == [{"charge_id": "pi_2", "approval": "customer_confirms"}]
    assert result.handoff is None


def test_handoff_comes_from_the_tool_result():
    result = TurnResult(session_id="s")
    read_events(result, [event("tool", "ai_agent", 1, data={"tool_calls": [
        {"tool_id": "x:transfer_to_human", "arguments": {}, "result": {"data": {"handoff": {"team": "Billing", "reason": "chargeback"}}}}]})])
    assert result.handoff == {"team": "Billing", "reason": "chargeback"}


def test_a_turn_is_finished_only_when_its_own_trace_is_ready():
    assert not turn_finished([event("status", "ai_agent", 1, trace="old", data={"status": "ready"})], "t1")
    assert not turn_finished([event("status", "ai_agent", 1, data={"status": "typing"})], "t1")
    assert turn_finished([event("status", "ai_agent", 1, data={"status": "ready"})], "t1")
    assert turn_finished([event("status", "ai_agent", 1, data={"status": "error"})], "t1")


def test_usage_adds_only_this_turns_traces():
    session = {"usage": {
        "warmup": {"requests": {"anthropic:claude-haiku-5-5": {"input_tokens": 999, "cached_input_tokens": 0, "output_tokens": 1}}, "costs": {"total": "1"}},
        "t1": {"requests": {"anthropic:claude-sonnet-5-5": {"input_tokens": 100, "cached_input_tokens": 50, "output_tokens": 20}}, "costs": {"total": "0.0012"}},
    }}
    result = TurnResult(session_id="s")
    add_usage(result, session, {"t1"})
    assert result.tokens == {"input_tokens": 100, "cached_input_tokens": 50, "output_tokens": 20}
    assert result.cost_usd == "0.00120"


def test_unpriced_usage_gives_no_cost():
    result = TurnResult(session_id="s")
    add_usage(result, {"usage": {"t1": {"requests": {}, "costs": None}}}, {"t1"})
    assert result.cost_usd is None


def test_tool_name_strips_the_service():
    assert tool_name("built-in:propose_refund") == "propose_refund"
