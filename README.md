# Payment API smoke suite (Playwright)

A P0 "is the platform alive?" smoke suite for a Payment Service Provider (PSP)
REST API — one self-contained Playwright file that runs in under two minutes and
covers the critical payment paths end to end.

Built while doing QA on a cross-border payments platform. **Sanitized standalone
example** — no real hosts, tenants, credentials or card data. Point it at your own
test environment via `.env`.

## What it checks

| # | Check | Asserts |
|---|-------|---------|
| S1 | Create payment | `200` + `payment_id` |
| S2 | Same `Idempotency-Key` twice | `200` then `422` (in-progress) |
| S3 | No key, same order twice | two **distinct** `payment_id` (order_number is not a dedup key) |
| S4 | Missing `X-Signature` | `401/403` (HMAC auth enforced) |
| S5 | Signed `GET /balances` | `200` + balances array |
| S6 | Ledger pair Σ=0 | *skipped* (needs the ledger service) |
| S7 | Payout base path | `200` or `insufficient_balance` |
| S8 | Console SSO login | reaches the console landing page |
| S9 | Country stop-list | US card on a ROW merchant → `422`, **blocked before the gateway** |
| S10 | Refund + webhook | `200` and the refund webhook carries a **valid HMAC signature** |
| S11 | `/health` on every service | all `200` |
| S12 | Payout happy-path | `200` or `insufficient_balance` |

Highlights: per-request **HMAC signing** (`HMAC-SHA256(secret, "<ts>.<body>")`),
**idempotency** semantics, negative auth (unsigned → rejected), a **geo/compliance
rule** verified to block before hitting the gateway, and **inbound webhook
signature verification** using a live [webhook.site](https://webhook.site) inbox.

## Run

```bash
npm install
npx playwright install chromium   # for the S8 SSO login test
cp .env.example .env              # fill in your OWN test credentials
npm run smoke
```

Run a single check from the list reporter or your IDE's ▶ gutter, e.g.:

```bash
npx playwright test -g "S9"
```

## Notes

- A safety rail refuses to run unless `SMOKE_BASE_URL` looks like a test env
  (`sandbox|staging|test|localhost|example`); override with `SMOKE_ALLOW_NONSANDBOX=1`.
- `422` for a declined card / insufficient balance / blocked country is an
  **expected business outcome**, asserted as such — not treated as a failure.
- Test PANs are standard non-routable numbers; swap for whatever your sandbox expects.
- No shared library: everything (env loader, signed client, helpers) is inline so
  the file is portable and easy to read.
