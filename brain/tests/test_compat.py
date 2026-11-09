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
