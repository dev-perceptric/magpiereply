# Magpie AI, phase 3: the team's own apps, read-only

Part of `docs/ai-agent-plan.md`, after `docs/phase-2.md`. Phase 3 lets Magpie look things up in each team's own apps, and lets a customer who chats without signing in prove which account is theirs.

## Status

| Part | Status |
|---|---|
| Connections: Settings → AI agent → Apps. Connect opens the app's own sign-in page; the admin approves MagpieReply there and comes back. Keys are stored encrypted per team and refreshed before they expire | Built (`agent/src/apps.ts`). MCP's own sign-in: discovery (RFC 9728 and 8414), PKCE, the `resource` parameter, and self-registration where the app offers it |
| Stripe: one click. Magpie reads the signed-in customer's charges and spots duplicates in the team's own Stripe account, through Stripe's MCP server | Built. Every lookup uses the verified customer's email, filled in by code. A team without Stripe connected gets no charge tools, and charge questions go to Billing |
| Linear: one click. Magpie checks whether a reported bug is known or fixed | Built (`brain/magpie_brain/apps.py`). Only tools the server marks read-only are offered. Magpie never shares issue links, ids or internal comments |
| HubSpot and Shopify | The sign-in works once their apps are registered (below). Their lookups come next: each needs coded, identity-locked tools like Stripe's, written once the real tools can be listed |
| Verification codes: when a customer isn't signed in and asks about their account, Magpie offers to email a 6-digit code. Typing it back makes that email theirs for the conversation, so Stripe lookups work | Built (`agent/src/verify.ts`, `MagpieMailer`). In Draft mode the code goes out when a teammate sends the reply; in Auto, with Magpie's reply. 10 minutes, 5 tries, 3 codes a conversation |
| The shared test Stripe account is used only by the trial now. The brain runs with `STRIPE_MODE=none` | Built |

## Checked on the live server (November 12, 2026)

- Connect for Stripe and Linear on account 1 returned each app's real sign-in page, after MCP self-registration. HubSpot says it needs setup.
- The 40-case trial, with Stripe passed in as a connection over MCP: 39 of 40 correct, 1 wrong, 10 of 10 rule and attack tests, slowest 5% 6.9 s, $0.0044 a turn. The wrong one said opened candles can't be returned, which the article doesn't say.
- Three prompt fixes came out of the trial runs: legal handoffs say only that a teammate will pick it up; nothing is promised about someone else's account; and Magpie's own rules are never quoted to customers as company policy.

## Setting up what needs you

**Email (needed for verification codes, and for every email the app sends).** The app has no email provider today, so invites and password resets don't go out either.

1. Make an account at an email provider with SMTP (Resend, Postmark or Amazon SES).
2. Add its DNS records for `magpiereply.com` in Hostinger DNS.
3. In hPanel → Docker Manager → `magpiereply` → Environment, add `SMTP_ADDRESS`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_AUTHENTICATION=login` and `SMTP_ENABLE_STARTTLS_AUTO=true`. Set `MAILER_SENDER_EMAIL` to `MagpieReply <hello@magpiereply.com>`.
4. Add `VERIFICATION_EMAILS: 'on'` to `agent-api` and `agent-worker`.

**HubSpot.** In a HubSpot developer account, create an app with the redirect URL `https://agent.magpiereply.com/connect/callback`. Then add `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET` to `agent-api` and `agent-worker`.

**Shopify.** In the Shopify Partners dashboard, create an app with the same redirect URL. Then add `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` the same way.

## Running cost

Claude prices from `omniscient/scripts/cost-model.mjs` (October 2026). Assumes 1,000 conversations per team each month with about 2.5 replies each, and an app lookup on 1 reply in 5: about 2,500 more tokens in and 100 out, so about $0.006 each.

| Item | Beta (50 teams) | Growth (500 teams) |
|---|---|---|
| Claude tokens for app lookups (check) | ~$150 | ~$1,500 |
| Stripe and Linear MCP servers | $0 | $0 |
| Verification code emails: inside the email plan already counted in `docs/hostinger.md` | $0 more | $0 more |
| **Phase 3 adds** | **~$150** | **~$1,500** |

This sits inside the plan's "agent answers and actions" line (~$900 at Beta, ~$9,000 at Growth): measured replies cost $0.004 a turn, well under the plan's $0.007.
