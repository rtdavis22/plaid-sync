# plaid-sync

Syncs Chase credit card transactions into Airtable via Plaid.

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

## How it works

`/transactions/sync` returns changes since a cursor, stored in `.plaid-item.json`.
The first run has no cursor and returns full history; later runs return only
what changed. The cursor is only persisted after every page is drained, so an
interruption replays the batch rather than skipping it.

Airtable writes are upserts keyed on `Transaction ID`, so re-running is
idempotent. Deletions are real: when a pending charge posts, Plaid removes the
pending transaction and adds a new one with a different ID.

## Scheduled runs

`.github/workflows/sync.yml` runs `npm run sync -- --full` daily at 12:00 UTC
(05:00 PT / 08:00 ET), plus on demand via the Actions tab. It needs these repo
secrets:

`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ACCESS_TOKEN`, `AIRTABLE_TOKEN`,
`AIRTABLE_BASE_ID`

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
- `.plaid-item.json` holds a long-lived access token to real financial data.
  It is gitignored. Treat it like a password.

## Resetting

To re-import full history, delete the `cursor` key from `.plaid-item.json`.
Existing Airtable rows will be updated in place rather than duplicated.
