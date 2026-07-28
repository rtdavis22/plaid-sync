import type { Transaction } from "plaid";
import { deleteRecords, listAllRecords, listTables, upsertRecords } from "./airtable.js";
import { reportAndExit } from "./plaid.js";
import { TABLE_NAME } from "./setup-airtable.js";
import { cardLabels, syncTransactions } from "./transactions.js";

const KEY_FIELD = "Transaction ID";

function requireBaseId(): string {
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!baseId) {
    console.error('Config error: missing AIRTABLE_BASE_ID. Run "npm run setup-airtable" to list bases.');
    process.exit(1);
  }
  return baseId;
}

function toRecord(t: Transaction, cards: Map<string, string>) {
  const category = t.personal_finance_category;
  return {
    fields: {
      Name: t.name,
      Date: t.date,
      // When the charge was authorized, vs Date which is when it posted.
      "Authorized Date": t.authorized_date ?? null,
      Amount: t.amount,
      Card: cards.get(t.account_id) ?? "unknown",
      "Category (Plaid)": category?.primary ?? "",
      "Category Detail (Plaid)": category?.detailed ?? "",
      "Category Confidence (Plaid)": category?.confidence_level ?? "",
      "Payment Channel (Plaid)": t.payment_channel ?? "",
      Pending: t.pending,
      "Merchant (Plaid)": t.merchant_name ?? "",
      "Merchant Website (Plaid)": t.website ?? "",
      "Merchant Logo (Plaid)": t.logo_url ?? "",
      [KEY_FIELD]: t.transaction_id,
    },
  };
}

async function main() {
  const full = process.argv.includes("--full");
  const baseId = requireBaseId();

  const { tables } = await listTables(baseId);
  const table = tables.find((t) => t.name === TABLE_NAME);
  if (!table) {
    throw new Error(`No "${TABLE_NAME}" table in ${baseId}. Run "npm run setup-airtable" first.`);
  }

  const { added, modified, removed } = await syncTransactions(full ? "full" : "incremental");
  const cards = await cardLabels();

  const upserts = [...added, ...modified].map((t) => toRecord(t, cards));
  const { created, updated } = await upsertRecords(baseId, table.id, [KEY_FIELD], upserts);

  const deleted = full
    ? await reconcile(baseId, table.id, added)
    : await deleteByTransactionId(baseId, table.id, removed.map((r) => r.transaction_id));

  console.log(`created ${created} · updated ${updated} · deleted ${deleted}`);
}

/**
 * Full mode gets no `removed` list — Plaid just stops returning the transaction.
 * So drop any synced row Plaid no longer knows about. Rows with a blank key were
 * added by hand in Airtable and are never touched.
 */
async function reconcile(baseId: string, tableId: string, current: Transaction[]) {
  if (current.length === 0) {
    // Deleting every row because an API hiccup returned nothing is unrecoverable.
    console.warn("Plaid returned no transactions; skipping reconcile rather than emptying the table.");
    return 0;
  }
  const live = new Set(current.map((t) => t.transaction_id));
  const stale = (await listAllRecords(baseId, tableId, [KEY_FIELD]))
    .filter((r) => {
      const key = r.fields[KEY_FIELD];
      return typeof key === "string" && key.length > 0 && !live.has(key);
    })
    .map((r) => r.id);
  return stale.length > 0 ? deleteRecords(baseId, tableId, stale) : 0;
}

async function deleteByTransactionId(baseId: string, tableId: string, transactionIds: string[]) {
  if (transactionIds.length === 0) return 0;
  const byKey = new Map(
    (await listAllRecords(baseId, tableId, [KEY_FIELD])).map((r) => [
      r.fields[KEY_FIELD] as string,
      r.id,
    ]),
  );
  const recordIds = transactionIds
    .map((id) => byKey.get(id))
    .filter((id): id is string => Boolean(id));
  return recordIds.length > 0 ? deleteRecords(baseId, tableId, recordIds) : 0;
}

main().catch(reportAndExit);
