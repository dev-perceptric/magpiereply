import anthropic
import httpx

import magpie_brain.compat  # noqa: F401


def test_parlant_style_timeouts_are_accepted():
    client = anthropic.AsyncAnthropic(api_key="test", timeout=httpx.Timeout(30.0, connect=5.0))
    assert client.timeout.connect == 5.0
    assert client.timeout.read == 30.0


def test_parlants_anthropic_adapter_builds_its_client():
    from parlant.adapters.nlp import anthropic_service

    client = anthropic.AsyncAnthropic(api_key="test", timeout=anthropic_service._ANTHROPIC_TIMEOUT)
    assert client.timeout is not None


def test_thinking_requests_drop_a_mismatched_block():
    from magpie_brain.compat import THINKING_BINDING_BETA, _drop_mismatched_thinking

    out = _drop_mismatched_thinking({"model": "m", "thinking": {"type": "adaptive"}, "extra_headers": {"anthropic-beta": "x"}})
    assert "thinking" not in out
    assert out["extra_body"]["thinking"] == {"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "drop_block"}}
    assert out["extra_headers"]["anthropic-beta"] == f"x,{THINKING_BINDING_BETA}"


def test_requests_without_thinking_are_left_alone():
    from magpie_brain.compat import _drop_mismatched_thinking

    assert _drop_mismatched_thinking({"model": "m"}) == {"model": "m"}
    assert _drop_mismatched_thinking({"thinking": {"type": "disabled"}}) == {"thinking": {"type": "disabled"}}


def test_the_sdk_sends_the_setting():
    import httpx2

    seen = {}

    def handler(request):
        seen["body"] = request.read()
        seen["beta"] = request.headers.get("anthropic-beta")
        return httpx2.Response(200, json={"id": "m", "type": "message", "role": "assistant", "model": "x", "content": [],
                                          "stop_reason": "end_turn", "usage": {"input_tokens": 1, "output_tokens": 1}})

    client = anthropic.Anthropic(api_key="test", http_client=httpx2.Client(transport=httpx2.MockTransport(handler)))
    client.messages.create(model="x", max_tokens=10, messages=[{"role": "user", "content": "hi"}], thinking={"type": "adaptive"})
    assert b'"prefix_mismatch_behavior":"drop_block"' in seen["body"].replace(b" ", b"")
    assert "thinking-binding-controls-2026-08-01" in seen["beta"]
