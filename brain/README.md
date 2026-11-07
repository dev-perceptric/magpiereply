# magpie-brain (Parlant trial)

[Parlant](https://github.com/emcie-co/parlant) 4.0.3 (Apache 2.0) running the Tidewell Coffee agent for the phase 0 trial (`docs/phase-0.md`, Days 8 and 9). The trial's runner drives it with `npm run trial -- run --setup parlant` (`agent/src/evals/setups/parlant.ts`).

- `main.py`: the server. Sonnet 5.5 writes the replies; Haiku 5.5 matches rules, reviews tool calls and builds indexes; Voyage makes Parlant's search vectors.
- `tidewell.py`: the agent. Its instructions hold the 29 help articles (cached), like the baseline. The rules are Parlant policies:
  - **duplicate charges:** the steps, with the lookup and refund tools and Parlant's tool review
  - **sign in first** and **chargebacks**, each ranked above the duplicate-charge steps
  - **refund timing**
  - **asks for a person**, **very upset or legal** and **no answer in the articles**, each with the handoff tool
- `stripe_gateway.py`: Stripe through the test team's gateway server, with the official MCP Python SDK.

## What changed from the plan

- **No journeys.** Parlant 4.0 dropped journeys and guidelines for policies and observations. The duplicate-charge journey is a policy with its steps written out.
- **No MCP in Parlant.** Parlant 4.0 can't call a remote MCP server, so the tools call the gateway with the MCP Python SDK. That is the plan's fallback, and it decides how apps connect later.
- **Approved wording comes from the bridge.** Parlant's canned responses are examples the model adapts, not fixed text. The bridge sends "refund started" and "handing off" word for word, as it does for the baseline.
- **Storage:** Parlant's local storage on a Fly volume, as planned for the trial. MongoDB only if we go ahead.

## Who does what

The tools look up, ask and hand off. The bridge (the trial's adapter, later `magpie-agent`) does the rest:

| Step | Who |
|---|---|
| Who the customer is | The bridge makes a Parlant customer with the signed-in email; `lookup_charges` reads it from there. Nobody signed in is a guest, and the lookup refuses |
| Asking for a refund | `request_refund` checks the charge came from this session's lookup and sets the gate: Confirm under $50, staff approval from $50 |
| Making the refund | The bridge, after the Confirm or approval, through the gateway |
| Handing off | `hand_off` records the team and note; the bridge sets the session to manual and sends the approved wording |

## Run it locally

Needs Python 3.12, an Anthropic key and a Voyage key. Parlant builds search vectors for its rules at startup, so it doesn't start without them.

```bash
cd brain && python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
```

```bash
ANTHROPIC_API_KEY=... VOYAGE_API_KEY=... GATEWAY_MCP_URL=... GATEWAY_TOKEN=... .venv/bin/python main.py
```

Without `PARLANT_ENV=production` it runs in development mode with no API key. Then, in `agent/`:

```bash
PARLANT_URL=http://localhost:8800 PARLANT_ADMIN_API_KEY=dev npm run trial -- run --setup parlant
```

Tests (no keys needed; the last one needs a gateway server in `TEST_GATEWAY_MCP_URL` and `TEST_GATEWAY_TOKEN`):

```bash
.venv/bin/python -m pytest
```

## Deploy to Fly

From the repo root, so the help articles are in the image:

```bash
fly apps create magpie-brain
```

```bash
fly volumes create brain_data --app magpie-brain --region nrt --size 1
```

```bash
fly secrets set --app magpie-brain ANTHROPIC_API_KEY=... VOYAGE_API_KEY=... PARLANT_ADMIN_API_KEY="$(openssl rand -hex 32)" GATEWAY_MCP_URL=... GATEWAY_TOKEN=...
```

```bash
fly deploy --config brain/fly.toml --dockerfile brain/Dockerfile .
```

The runner then uses `PARLANT_URL=https://magpie-brain.fly.dev` and the same admin key.

## Running cost

| Item | During the trial | If it's a go (Beta, 50 teams) |
|---|---|---|
| `magpie-brain`, shared-cpu-2x 2 GB, always on, plus a 1 GB volume (check) | ~$12 a month | ~$26 (plan, section 7) |
| Voyage | $0 (free amount) | ~$0 |
| Claude | Several calls per turn: Haiku to match and review, Sonnet to reply. The trial measures it; the target is under $0.03 a turn | in the plan's agent cost |

If the trial is a no-go, `magpie-brain` is shut down.
