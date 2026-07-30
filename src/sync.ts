import type { Transaction } from "plaid";
import type { AirtableRecord } from "./airtable.js";
import {
  deleteRecords,
  listAllRecords,
  listTables,
  updateRecords,
  upsertRecords,
} from "./airtable.js";
import { reportAndExit } from "./plaid.js";
import {
  CATEGORIES_TABLE,
  CATEGORY_FIELD,
  categorize,
  loadCategories,
  type CategoryIndex,
} from "./categories.js";
import { OVERRIDE_FIELD, TABLE_NAME } from "./setup-airtable.js";
import { accountLabels, syncTransactions } from "./transactions.js";

const KEY_FIELD = "Transaction ID";

/** The one column the override protects. Everything else still syncs. */
const PROTECTED_FIELD = "Amount";

/** Airtable omits empty values entirely, so absence is the common case. */
function isSet(value: unknown): boolean {
  if (value === undefined || value === null || value === "" || value === false) return false;
  if (Array.isArray(value)) return value.length === 0 ? false : true;
  return true;
}

function requireBaseId(): string {
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!baseId) {
    console.error('Config error: missing AIRTABLE_BASE_ID. Run "npm run setup-airtable" to list bases.');
    process.exit(1);
  }
  return baseId;
}

function toRecord(
  t: Transaction,
  labels: Map<string, string>,
  protectAmount: boolean,
  index: CategoryIndex,
) {
  const category = t.personal_finance_category;
  const matched = categorize(t.merchant_name, t.name, index);
  const fields: Record<string, unknown> = {
      Name: t.name,
      Date: t.date,
      // When the charge was authorized, vs Date which is when it posted.
      "Authorized Date": t.authorized_date ?? null,
      Account: labels.get(t.account_id) ?? "unknown",
      "Category (Plaid)": category?.primary ?? "",
      "Category Detail (Plaid)": category?.detailed ?? "",
      "Category Confidence (Plaid)": category?.confidence_level ?? "",
      "Payment Channel (Plaid)": t.payment_channel ?? "",
      Pending: t.pending,
      "Merchant (Plaid)": t.merchant_name ?? "",
      "Merchant Website (Plaid)": t.website ?? "",
      "Merchant Logo (Plaid)": t.logo_url ?? "",
      [KEY_FIELD]: t.transaction_id,
  };

  // Omitting Amount leaves the hand-corrected value alone — an upsert only
  // writes the fields it is given. OVERRIDE_FIELD is never written here: it is
  // a human's marker, and sync only ever reads it.
  if (!protectAmount) fields[PROTECTED_FIELD] = t.amount;

  // Only write Category on a match. Writing a fallback would overwrite
  // categories set by hand, and Plaid's taxonomy would pollute the list.
  if (matched) fields[CATEGORY_FIELD] = [matched.id];

  return { fields };
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
  const labels = await accountLabels();

  // One read serves the carry-forward, the override lookup, and the deletes.
  const hasOverride = table.fields.some((f) => f.name === OVERRIDE_FIELD);
  const columns = hasOverride ? [KEY_FIELD, OVERRIDE_FIELD] : [KEY_FIELD];
  const existing = await listAllRecords(baseId, table.id, columns);

  // Must run before anything keys off Transaction ID — it rewrites those keys.
  const carried = await carryForwardPending(baseId, table.id, existing, [...added, ...modified]);

  const protectedIds = new Set(
    existing
      .filter((r) => hasOverride && isSet(r.fields[OVERRIDE_FIELD]))
      .map((r) => r.fields[KEY_FIELD] as string),
  );

  const categoriesTable = tables.find((t) => t.name === CATEGORIES_TABLE);
  if (!categoriesTable) {
    throw new Error(`No "${CATEGORIES_TABLE}" table in ${baseId}. Run "npm run setup-airtable".`);
  }

  // Writing record ids into a single-select would fail confusingly.
  const categoryField = table.fields.find((f) => f.name === CATEGORY_FIELD);
  if (categoryField && categoryField.type !== "multipleRecordLinks") {
    throw new Error(
      `"${CATEGORY_FIELD}" is a ${categoryField.type}, not a link to "${CATEGORIES_TABLE}". ` +
        `Convert it in Airtable: field menu → Edit field → Link to another record → ${CATEGORIES_TABLE}.`,
    );
  }

  const index = await loadCategories(baseId, categoriesTable.id);

  const upserts = [...added, ...modified].map((t) =>
    toRecord(t, labels, protectedIds.has(t.transaction_id), index),
  );
  const { created, updated } = await upsertRecords(baseId, table.id, [KEY_FIELD], upserts);

  const deleted = full
    ? await reconcile(baseId, table.id, existing, added)
    : await deleteByTransactionId(baseId, table.id, existing, removed.map((r) => r.transaction_id));

  const held = upserts.length - upserts.filter((u) => PROTECTED_FIELD in u.fields).length;
  const note = held > 0 ? ` · ${PROTECTED_FIELD} held on ${held} (${OVERRIDE_FIELD} set)` : "";
  const forwarded = carried > 0 ? ` · carried ${carried} pending→posted` : "";
  console.log(`created ${created} · updated ${updated} · deleted ${deleted}${note}${forwarded}`);

  const matched = [...added, ...modified].filter((t) =>
    categorize(t.merchant_name, t.name, index),
  ).length;
  console.log(
    `${index.categories} categor(ies) · ${index.merchants} merchant(s) · matched ${matched}/${upserts.length}`,
  );
}

/**
 * Plaid does not update a pending transaction when it posts. It withdraws it
 * and reissues the charge under a new id, with `pending_transaction_id` naming
 * the one it replaced.
 *
 * Left alone, reconcile would delete the pending row as stale and the posted
 * charge would arrive as a fresh record — taking the receipt, notes, category
 * and item links attached to it. Rewriting the existing row's key instead
 * carries that record forward, so everything hanging off it survives.
 */
async function carryForwardPending(
  baseId: string,
  tableId: string,
  existing: AirtableRecord[],
  incoming: Transaction[],
) {
  const byKey = new Map(existing.map((r) => [r.fields[KEY_FIELD] as string, r]));
  const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];

  for (const t of incoming) {
    const pendingId = t.pending_transaction_id;
    if (!pendingId) continue;

    const row = byKey.get(pendingId);
    // No row under the old key, or the posted id is already present — either
    // way there is nothing to carry, and rewriting would duplicate the key.
    if (!row || byKey.has(t.transaction_id)) continue;

    updates.push({ id: row.id, fields: { [KEY_FIELD]: t.transaction_id } });

    // Keep the in-memory view in step: reconcile reads it, and a row still
    // holding the withdrawn id would be deleted moments after being carried.
    row.fields[KEY_FIELD] = t.transaction_id;
    byKey.delete(pendingId);
    byKey.set(t.transaction_id, row);
  }

  if (updates.length > 0) await updateRecords(baseId, tableId, updates);
  return updates.length;
}

/**
 * Full mode gets no `removed` list — Plaid just stops returning the transaction.
 * So drop any synced row Plaid no longer knows about. Rows with a blank key were
 * added by hand in Airtable and are never touched.
 */
async function reconcile(
  baseId: string,
  tableId: string,
  existing: AirtableRecord[],
  current: Transaction[],
) {
  if (current.length === 0) {
    // Deleting every row because an API hiccup returned nothing is unrecoverable.
    console.warn("Plaid returned no transactions; skipping reconcile rather than emptying the table.");
    return 0;
  }
  const live = new Set(current.map((t) => t.transaction_id));
  const stale = existing
    .filter((r) => {
      const key = r.fields[KEY_FIELD];
      return typeof key === "string" && key.length > 0 && !live.has(key);
    })
    .map((r) => r.id);
  return stale.length > 0 ? deleteRecords(baseId, tableId, stale) : 0;
}

async function deleteByTransactionId(
  baseId: string,
  tableId: string,
  existing: AirtableRecord[],
  transactionIds: string[],
) {
  if (transactionIds.length === 0) return 0;
  const byKey = new Map(existing.map((r) => [r.fields[KEY_FIELD] as string, r.id]));
  const recordIds = transactionIds
    .map((id) => byKey.get(id))
    .filter((id): id is string => Boolean(id));
  return recordIds.length > 0 ? deleteRecords(baseId, tableId, recordIds) : 0;
}

main().catch(reportAndExit);
