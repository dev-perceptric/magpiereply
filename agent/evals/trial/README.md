# Parlant trial: test data

Test data for the phase 0 trial in `docs/phase-0.md` (Week 2, Day 7).

## The made-up store

**Tidewell Coffee**, a coffee roaster in Portland, Oregon. It sells coffee, brewing gear and coffee subscriptions, and takes card payments through Stripe. Its facts stay the same across every article:

| Topic | Fact |
|---|---|
| Ships to | US, Canada and UK only |
| US shipping | Standard $6, free from $50; Express $15 |
| Canada / UK shipping | $14 / $18, import taxes may apply |
| Roasting | Monday to Thursday, 12:00 pm Pacific cutoff |
| Change or cancel an order | Yourself within 1 hour; after that, only before Roasting |
| Returns | Unused gear within 30 days; coffee is covered by the Freshness promise |
| Refunds | Issued within 2 business days; bank shows it in 5 to 10 business days |
| Card holds | Drop off in 3 to 7 business days; we can't remove them |
| Subscriptions | Every 1, 2 or 4 weeks; change by 11:59 pm Pacific the day before renewal |
| Sign-in | Email code, no passwords; identity check uses an order number and the card's last 4 digits |

## Articles (`articles/`)

29 articles in 5 categories: orders and shipping (9), returns and refunds (4), billing and payments (9), subscriptions (4) and account (3).

**Outdated on purpose:** `free-shipping-over-35.md` says US shipping is free from $35 and costs $5, dated February 2025. It conflicts with `where-we-ship.md` ($50 and $6). The agent should answer with the current article. Later, knowledge health should flag the conflict.

**No answer on purpose:** the articles say nothing about these, so the agent should hand off instead of guessing. Use them for the 2 knowledge tests that have no answer:

- wholesale or bulk prices for cafes and offices
- whether the bags are compostable or recyclable

## Load them into MagpieReply

Needs Node 22 and an administrator API key (Profile settings → Access token). It creates the `tidewell` help center and its categories if they're missing, then adds each article as published. Running it again skips articles that are already there.

```bash
APP_URL=https://app.magpiereply.com node agent/evals/trial/load-articles.mjs --account <id>
```

## Running cost

None. The articles live in the app's existing database, and loading them uses no Claude tokens.
