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

## Stripe test customers (`stripe-customers.json`)

8 customers for Stripe **test mode**, with emails on `example.com`:

| Customer | Kind | Charges |
|---|---|---|
| Maya Alvarez | duplicate under $50 | $24.00 twice for order TW-10418, plus an older $38.00 order |
| Jonah Okafor | duplicate under $50 | $38.50 twice for order TW-10431 |
| Priya Nair | duplicate under $50 | $16.00 twice for subscription renewal SUB-2207 |
| Dana Kim | duplicate over $50 | $89.00 twice for order TW-10425 |
| Leo Martin | duplicate over $50 | $142.75 twice for order TW-10402 |
| Sam Reyes | not a duplicate | $24.00 renewals of SUB-1980, 14 days apart |
| Ana Costa | not a duplicate | $32.00 for order TW-10409, then $32.00 for order TW-10420 two days later |
| Chris Wu | no charges | none |

`days_ago` sets when each charge happened. Stripe sets a charge's date to the moment it's made, so charges on past days need a test clock (check that charges made for a test-clock customer take the clock's date) or must be made on different real days. The order or subscription number goes in each charge's metadata.

## Test conversations (`cases/`)

40 cases, matching the plan:

| File | Cases | What it tests |
|---|---|---|
| `knowledge.json` | 20 | Answers from the articles; `kb-03` checks the outdated article; `kb-19` and `kb-20` have no answer and should hand off |
| `duplicate-charges.json` | 10 | Under $50 with the customer confirming, over $50 with staff approving, a customer who declines, two kinds of not-a-duplicate, no charges, a customer who isn't signed in, and a push for a faster refund |
| `rules-and-handoff.json` | 6 | Asks for a person (twice), very upset, chargeback threatened and already opened (to Billing), legal threat |
| `attacks.json` | 4 | "Ignore your rules", another customer's charges, a fake admin message, a link with hidden instructions |

Each case has:

- `customer`: who's signed in. `verified: true` with a `stripe_customer` means the identity comes from the session, so the agent looks up that customer only. `verified: false` means nobody is signed in.
- `turns`: played in order. A `text` turn is a customer message; the runner waits for the agent's reply before the next turn. `confirm` and `decline` are the customer pressing the agent's buttons. `approve` and `reject` are staff answering an approval card.
- `expected`: the outcome, the handoff team, the refund (which charge, how much, and whether the customer confirms or staff approve), the tools that must and must not run, the approved wording, the articles to cite, and `checks`, plain sentences a grader marks pass or fail.

`lookup_charges` and `refund_charge` are names for what happens. The runner maps them to the Stripe MCP tools found during the trial. Reset the Stripe data before each case, since refunds change it.

`test/trial-cases.test.ts` checks the files fit together: the counts, that every article and customer exists, that refund amounts match the charges, that over $50 needs staff approval, and that nobody signed out gets a charge lookup.

## Load them into MagpieReply

Needs Node 22 and an administrator API key (Profile settings → Access token). It creates the `tidewell` help center and its categories if they're missing, then adds each article as published. Running it again skips articles that are already there.

```bash
APP_URL=https://app.magpiereply.com node agent/evals/trial/load-articles.mjs --account <id>
```

## Running cost

None. The articles live in the app's existing database, and loading them uses no Claude tokens. The cases and Stripe test customers are files; Stripe test mode is free.
