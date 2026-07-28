# plaid-sync

Syncs bank and credit card transactions into Airtable via Plaid, across any
number of linked institutions.

## Setup

Credentials come from the environment (`.env`, or exports in your shell profile).
See `.env.example`.

**Plaid** — client ID and production secret from the Plaid dashboard.

**Airtable** — a personal access token from
[airtable.com/create/tokens](https://airtable.com/create/tokens), created while
logged into the account that owns the target base. Scopes:

- `data.records:read`, `data.records:write`
- `schema.bases:read`, `schema.bases:write`

Grant the token access to the base you want to sync into.

## Commands

| Command | What it does |
| --- | --- |
| `npm run connect` | Creates a Plaid Hosted Link URL. Open it and authorize the card. |
| `npm run exchange` | Turns the completed Link session into a stored access token. |
| `npm run transactions` | Prints a transaction sync to stdout. Debugging only — **advances the cursor**. |
| `npm run setup-airtable` | Lists bases, or creates the `Transactions` table once `AIRTABLE_BASE_ID` is set. |
| `npm run sync` | The real thing: Plaid → Airtable. Safe to run repeatedly. |
| `npm run receipts` | Reads receipts into `Items`. `-- --dry-run` extracts without writing. |

## How it works

`/transactions/sync` returns changes since a cursor, stored per item in `.plaid-items.json`.
The first run has no cursor and returns full history; later runs return only
what changed. The cursor is only persisted after every page is drained, so an
interruption replays the batch rather than skipping it.

Airtable writes are upserts keyed on `Transaction ID`, so re-running is
idempotent. Deletions are real: when a pending charge posts, Plaid removes the
pending transaction and adds a new one with a different ID.

## Columns

Columns holding Plaid's own inference or enrichment are suffixed `(Plaid)`.
Unsuffixed columns are what the bank reported.

| Column | Source | Fill |
| --- | --- | --- |
| Name | bank description | 100% |
| Date | posted date | 100% |
| Authorized Date | when the charge was authorized | 100% |
| Amount | positive = purchase, negative = payment/refund | 100% |
| Account | institution and last four, e.g. `Chase ····0195` | 100% |
| Category | your category, linked to the `Categories` table | rules |
| Category (Plaid) | Plaid's primary taxonomy, ~14 values | 100% |
| Category Detail (Plaid) | e.g. `FOOD_AND_DRINK_FAST_FOOD` | 100% |
| Category Confidence (Plaid) | `VERY_HIGH` … `LOW` | 100% |
| Payment Channel (Plaid) | `in store` / `online` / `other` | 100% |
| Pending | provisional; amount and merchant can change | — |
| Merchant (Plaid) | cleaned merchant name | 95% |
| Merchant Website (Plaid) | | 60% |
| Merchant Logo (Plaid) | Plaid-hosted image URL | 60% |
| Receipt | attach a photo or PDF to have its line items extracted | manual |
| Receipt Processed | which attachment was read; written by the reader | auto |
| Items | link to the extracted receipt lines | auto |
| Overridden From | set by hand to protect a corrected Amount | manual |
| Transaction ID | Plaid's id; the upsert key, never edit | 100% |

### Correcting an amount

Plaid sometimes reports a wrong amount. To fix one by hand, edit `Amount` and
record the value you overrode in `Overridden From`. Any row with `Overridden
From` set keeps its `Amount` through every sync — the upsert simply omits that
one field, so every other column still updates normally. Clear `Overridden
From` to hand the row back to Plaid.

Sync **only reads** this column, never writes it. Each run reports how many
amounts it held.

`Category (Plaid)` is **Plaid's** taxonomy, not the bank's, and will not match
what the bank's own app shows.
About 28% of rows come back `LOW` confidence, so treat those as suggestions.
Card payments land in `LOAN_DISBURSEMENTS`, which is intended, not a misfire.

Fields deliberately omitted because Chase populates them poorly or not at all:
`location.*` (~20%), `original_description`, `check_number`, `transaction_code`
(0%), and `counterparties` (duplicates the merchant name).

`npm run setup-airtable` is idempotent — it renames and adds columns to match
the schema above, then leaves an already-correct table alone. After a schema
change, run `npm run sync -- --full` to backfill.

## Reading receipts

Attach a photo or PDF to `Receipt` on any transaction, then run
`npm run receipts`. It sends the image to Claude, extracts the line items, and
writes one `Items` row per line, linked back to the transaction. Category does
not matter — a receipt is a receipt. Needs `ANTHROPIC_API_KEY`; roughly 2–4¢
per receipt.

`-- --dry-run` prints what it would extract without writing anything. Use it
first on an unfamiliar receipt.

A receipt is read once. `Receipt Processed` records which attachment was used,
so swapping in a clearer photo re-reads it — deleting the previous items first —
while a re-run over an unchanged receipt does nothing. Several images on one
transaction are read together as a single multi-page receipt.

Each receipt's total is checked against the charged amount and a gap over 2¢ is
reported. OCR misreads a digit occasionally, and a wrong price looks exactly
like a right one once it is a row in the table.

## Scheduled runs

`.github/workflows/sync.yml` runs `npm run sync -- --full` then `npm run receipts` daily at 12:00 UTC
(05:00 PT / 08:00 ET), plus on demand via the Actions tab. It needs these repo
secrets:

`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ACCESS_TOKENS` (comma-separated, one
per institution), `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`, `ANTHROPIC_API_KEY`

CI uses `--full` because runners are ephemeral — there is nowhere to keep a
cursor between runs, so each run re-reads the window and reconciles.

GitHub cron is UTC and ignores daylight saving, so the local run time shifts by
an hour twice a year. A failed run sends an email; a Plaid Item that needs
re-authentication will surface that way.

`.npmrc` pins the public registry. Installing from a machine configured against
a private npm proxy otherwise writes proxy URLs into the lockfile, and `npm ci`
fails in CI with a 401.

## Notes

- **Amount sign** follows Plaid's convention: on a credit card, a positive
  amount is a purchase and a negative amount is a payment or refund.
- **Pending rows change.** A pending charge's merchant name and amount are
  provisional; both can shift when it posts.
- `.plaid-items.json` holds long-lived access tokens to real financial data.
  It is gitignored. Treat it like a password.

## Resetting

To re-import full history, delete the `cursor` key from `.plaid-items.json`.
Existing Airtable rows will be updated in place rather than duplicated.
