import type { RemovedTransaction, Transaction } from "plaid";
import { accessToken, readCursor, writeCursor } from "./item.js";
import { plaid, reportAndExit } from "./plaid.js";

export type SyncResult = {
  added: Transaction[];
  modified: Transaction[];
  removed: RemovedTransaction[];
  /** True when this was a full fetch, so `added` is the complete current set. */
  full: boolean;
};

/**
 * Drain /transactions/sync until has_more is false.
 *
 * "incremental" resumes from the stored cursor and saves the new one — cheap, but
 * needs durable local state. "full" starts from no cursor and saves nothing, so
 * `added` is every transaction Plaid currently knows about. Ephemeral runners
 * (GitHub Actions) must use "full"; there is nowhere to keep a cursor between runs.
 *
 * The cursor is only persisted after every page is drained, so an interruption
 * replays the batch rather than skipping it.
 */
export async function syncTransactions(mode: "incremental" | "full"): Promise<SyncResult> {
  const token = accessToken();
  const added: Transaction[] = [];
  const modified: Transaction[] = [];
  const removed: RemovedTransaction[] = [];

  let cursor = mode === "incremental" ? readCursor() : undefined;
  let hasMore = true;

  while (hasMore) {
    const { data } = await plaid.transactionsSync({
      access_token: token,
      cursor,
      count: 500,
    });
    added.push(...data.added);
    modified.push(...data.modified);
    removed.push(...data.removed);
    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  if (mode === "incremental" && cursor) writeCursor(cursor);
  return { added, modified, removed, full: mode === "full" };
}

/** ····1234 rather than a raw account_id, so the Airtable column is readable. */
export async function cardLabels(): Promise<Map<string, string>> {
  const { data } = await plaid.accountsGet({ access_token: accessToken() });
  return new Map(data.accounts.map((a) => [a.account_id, `····${a.mask ?? "????"}`]));
}

async function main() {
  const full = process.argv.includes("--full");
  const { added, modified, removed } = await syncTransactions(full ? "full" : "incremental");
  const cards = await cardLabels();

  console.log(`added ${added.length} · modified ${modified.length} · removed ${removed.length}\n`);

  for (const t of [...added].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15)) {
    const card = cards.get(t.account_id) ?? "?";
    const amount = t.amount.toFixed(2).padStart(9);
    const pending = t.pending ? " (pending)" : "";
    console.log(`${t.date}  ${card}  ${amount}  ${t.name}${pending}`);
  }
  if (added.length > 15) console.log(`... and ${added.length - 15} more`);
}

// Only run when invoked directly, so sync.ts can import the helpers above.
if (process.argv[1]?.endsWith("transactions.ts")) {
  main().catch(reportAndExit);
}
