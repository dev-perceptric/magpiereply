"""Creates the trial's 8 customers and their charges in a Stripe account in TEST MODE, to match
stripe_fixture.json, and writes stripe_ids.json so the trial can find the real ids.

    STRIPE_SECRET_KEY=sk_test_... python -m trial.seed_stripe

Stripe sets each charge's date to now, so duplicates are told apart by order and description,
which the fixture already does. Refuses any key that isn't a test key.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent


def ids_path() -> Path:
    """Real Stripe ids for the fixture's charges, kept on the data volume so they outlive the container."""
    return Path(os.environ.get("DATA_DIR", "/data")) / "trial" / "stripe_ids.json"
API = "https://api.stripe.com/v1"


def main() -> None:
    key = os.environ["STRIPE_SECRET_KEY"]
    if not key.startswith(("sk_test_", "rk_test_")):
        raise SystemExit("Use a Stripe test-mode key (sk_test_ or rk_test_). No real money in the trial.")
    http = httpx.Client(base_url=API, auth=(key, ""), timeout=30)
    ids: dict[str, str] = {}
    for row in json.loads((HERE / "stripe_fixture.json").read_text()):
        found = http.get("/customers", params={"email": row["email"], "limit": 1}).raise_for_status().json()["data"]
        if found:
            customer = found[0]
            print(f"{row['email']}: already there ({customer['id']}), skipping")
            continue
        customer = http.post("/customers", data={"email": row["email"], "name": row["name"], "metadata[trial]": "magpie"}).raise_for_status().json()
        for charge in row["charges"]:
            intent = http.post(
                "/payment_intents",
                data={
                    "amount": charge["amount_cents"],
                    "currency": charge["currency"],
                    "customer": customer["id"],
                    "description": charge["description"],
                    "payment_method": "pm_card_visa",
                    "confirm": "true",
                    "automatic_payment_methods[enabled]": "true",
                    "automatic_payment_methods[allow_redirects]": "never",
                    "metadata[trial_id]": charge["id"],
                },
            ).raise_for_status().json()
            ids[charge["id"]] = intent["id"]
        print(f"{row['email']}: {customer['id']} with {len(row['charges'])} charges")
    path = ids_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = json.loads(path.read_text()) if path.exists() else {}
    path.write_text(json.dumps({**existing, **ids}, indent=2))
    print(f"saved {path}")


if __name__ == "__main__":
    main()
