import type { RemovedTransaction, Transaction } from "plaid";
import { CountryCode } from "plaid";
import { accessTokens, readCursor, writeCursor } from "./item.js";
import { plaid, reportAndExit } from "./plaid.js";

export type SyncResult = {
  added: Transaction[];
  modified: Transaction[];
  removed: RemovedTransaction[];
  /** True when this was a full fetch, so `added` is the complete current set. */
  full: boolean;
};

/**
 * Drain /transactions/sync for one Item until has_more is false.
 *
 * The cursor is only persisted after every page is drained, so an interruption
 * replays the batch rather than skipping it.
 */
async function syncItem(token: string, mode: "incremental" | "full") {
  const added: Transaction[] = [];
  const modified: Transaction[] = [];
  const removed: RemovedTransaction[] = [];

  let cursor = mode === "incremental" ? readCursor(token) : undefined;
  let hasMore = true;

  while (hasMore) {
    const { data } = await plaid.transactionsSync({ access_token: token, cursor, count: 500 });
    added.push(...data.added);
    modified.push(...data.modified);
    removed.push(...data.removed);
    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  if (mode === "incremental" && cursor) writeCursor(token, cursor);
  return { added, modified, removed };
}

/**
 * Sync every linked Item and merge the results.
 *
 * "incremental" resumes from each Item's stored cursor. "full" starts from no
 * cursor and saves nothing, so `added` is every transaction Plaid currently
 * knows about. Ephemeral runners (GitHub Actions) must use "full"; there is
 * nowhere to keep a cursor between runs.
 *
 * A failing Item throws rather than returning partial data. That matters:
 * `--full` reconciliation deletes Airtable rows Plaid no longer returns, so
 * silently skipping a dead Item would wipe that institution's history.
 */
export async function syncTransactions(mode: "incremental" | "full"): Promise<SyncResult> {
  const results = await Promise.all(accessTokens().map((token) => syncItem(token, mode)));
  return {
    added: results.flatMap((r) => r.added),
    modified: results.flatMap((r) => r.modified),
    removed: results.flatMap((r) => r.removed),
    full: mode === "full",
  };
}

/** "Chase ····0195" rather than a raw account_id, so the Airtable column reads. */
export async function accountLabels(): Promise<Map<string, string>> {
  const labels = new Map<string, string>();

  for (const token of accessTokens()) {
    const { data } = await plaid.accountsGet({ access_token: token });

    let institution = "";
    const id = data.item.institution_id;
    if (id) {
      try {
        const { data: inst } = await plaid.institutionsGetById({
          institution_id: id,
          country_codes: [CountryCode.Us],
        });
        institution = inst.institution.name;
      } catch {
        institution = id; // A missing display name should not fail the sync.
      }
    }

    for (const account of data.accounts) {
      const mask = `····${account.mask ?? "????"}`;
      labels.set(account.account_id, institution ? `${institution} ${mask}` : mask);
    }
  }

  return labels;
}

async function main() {
  const full = process.argv.includes("--full");
  const { added, modified, removed } = await syncTransactions(full ? "full" : "incremental");
  const labels = await accountLabels();

  console.log(`added ${added.length} · modified ${modified.length} · removed ${removed.length}\n`);

  for (const t of [...added].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15)) {
    const label = (labels.get(t.account_id) ?? "?").padEnd(22);
    const amount = t.amount.toFixed(2).padStart(9);
    const pending = t.pending ? " (pending)" : "";
    console.log(`${t.date}  ${label}  ${amount}  ${t.name}${pending}`);
  }
  if (added.length > 15) console.log(`... and ${added.length - 15} more`);
}

// Only run when invoked directly, so sync.ts can import the helpers above.
if (process.argv[1]?.endsWith("transactions.ts")) {
  main().catch(reportAndExit);
}
