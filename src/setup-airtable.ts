import {
  createField,
  createTable,
  listBases,
  listTables,
  renameField,
  renameTable,
} from "./airtable.js";
import { CATEGORIES_TABLE, CATEGORY_FIELD, MERCHANTS_FIELD, NAME_FIELD } from "./categories.js";
import {
  ITEM_COST_FIELD,
  ITEM_NAME_FIELD,
  ITEMS_LINK_FIELD,
  ITEMS_TABLE,
  ITEMS_TRANSACTION_FIELD,
} from "./receipts-schema.js";

export const TABLE_NAME = "Transactions";

/**
 * Set by hand only — sync reads it and never writes it. When a row has this
 * set, sync leaves that row's Amount alone. Clear it to hand the row back.
 */
export const OVERRIDE_FIELD = "Overridden From";

/**
 * Which receipt attachment has already been read into Items. Written by
 * `npm run receipts`; swapping in a different photo makes it re-read.
 */
export const PROCESSED_FIELD = "Receipt Processed";

/**
 * Desired schema. Columns carrying Plaid's own inference or enrichment are
 * suffixed "(Plaid)"; columns reporting what the bank sent are not.
 *
 * Primary field first — Airtable makes field[0] primary, and an opaque ID is a
 * poor one. Order only matters when creating the table from scratch.
 */
const fieldsFor = (categoriesTableId: string) => [
  { name: "Name", type: "singleLineText" },
  { name: "Date", type: "date", options: { dateFormat: { name: "iso" } } },
  { name: "Authorized Date", type: "date", options: { dateFormat: { name: "iso" } } },
  { name: "Amount", type: "currency", options: { precision: 2, symbol: "$" } },
  { name: "Account", type: "singleLineText" },
  // Assigned by matching Merchant (Plaid) against the Categories table.
  {
    name: CATEGORY_FIELD,
    type: "multipleRecordLinks",
    options: { linkedTableId: categoriesTableId },
  },
  { name: "Category (Plaid)", type: "singleLineText" },
  { name: "Category Detail (Plaid)", type: "singleLineText" },
  { name: "Category Confidence (Plaid)", type: "singleLineText" },
  { name: "Payment Channel (Plaid)", type: "singleLineText" },
  { name: "Pending", type: "checkbox", options: { color: "yellowBright", icon: "check" } },
  { name: "Merchant (Plaid)", type: "singleLineText" },
  { name: "Merchant Website (Plaid)", type: "url" },
  { name: "Merchant Logo (Plaid)", type: "url" },
  // Set this on a row to stop sync overwriting that row's Amount.
  { name: OVERRIDE_FIELD, type: "currency", options: { precision: 2, symbol: "$" } },
  // Written by the receipt reader. Never edit this column by hand.
  { name: PROCESSED_FIELD, type: "singleLineText" },
  // The dedupe key for upserts. Never edit this column by hand.
  { name: "Transaction ID", type: "singleLineText" },
];

/** Applied before adding missing fields, so a rename isn't mistaken for a new column. */
const RENAMES: Array<[from: string, to: string]> = [
  ["Category", "Category (Plaid)"],
  ["Merchant", "Merchant (Plaid)"],
  ["Override From", OVERRIDE_FIELD],
  // Was card-only until a second institution was linked.
  ["Card", "Account"],
  // Receipts are read for every category now, not just groceries.
  ["Grocery Items", ITEMS_LINK_FIELD],
];

/** Applied before anything looks a table up by name. */
const TABLE_RENAMES: Array<[from: string, to: string]> = [["Grocery Items", ITEMS_TABLE]];

async function main() {
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!baseId) {
    const { bases } = await listBases();
    console.log("Set AIRTABLE_BASE_ID to one of these, then re-run:\n");
    for (const base of bases) {
      console.log(`  ${base.id}  ${base.name}  (${base.permissionLevel})`);
    }
    if (bases.length === 0) {
      console.log("  (none — create a base at airtable.com, or check the token's base access)");
    }
    return;
  }

  const { tables } = await listTables(baseId);

  // Before any lookup by name, so a rename is not mistaken for a missing table.
  for (const [from, to] of TABLE_RENAMES) {
    const stale = tables.find((t) => t.name === from);
    if (stale && !tables.some((t) => t.name === to)) {
      await renameTable(baseId, stale.id, to);
      stale.name = to;
      console.log(`renamed table "${from}" → "${to}"`);
    }
  }

  // Categories must exist first: the Category column links to it.
  let categories = tables.find((t) => t.name === CATEGORIES_TABLE);
  if (!categories) {
    const created = await createTable(baseId, {
      name: CATEGORIES_TABLE,
      description: "One row per category. List its merchants, one per line.",
      fields: [
        { name: NAME_FIELD, type: "singleLineText" },
        { name: MERCHANTS_FIELD, type: "multilineText" },
      ],
    });
    categories = { ...created, fields: [] };
    console.log(`Created table "${created.name}" (${created.id}).`);
  }

  const FIELDS = fieldsFor(categories.id);
  const table = tables.find((t) => t.name === TABLE_NAME);

  if (!table) {
    const created = await createTable(baseId, {
      name: TABLE_NAME,
      description: "Transactions synced from Plaid.",
      fields: FIELDS,
    });
    console.log(`Created table "${created.name}" (${created.id}) with ${FIELDS.length} fields.`);
    await ensureItems(baseId, tables, created.id);
    return;
  }

  // Bring an existing table up to the current schema. Idempotent: re-running is a no-op.
  const present = new Map(table.fields.map((f) => [f.name, f]));
  let changed = 0;

  for (const [from, to] of RENAMES) {
    const field = present.get(from);
    if (field && !present.has(to)) {
      await renameField(baseId, table.id, field.id, to);
      present.delete(from);
      present.set(to, { ...field, name: to });
      console.log(`renamed "${from}" → "${to}"`);
      changed++;
    }
  }

  for (const field of FIELDS) {
    if (present.has(field.name)) continue;
    await createField(baseId, table.id, field);
    console.log(`added "${field.name}" (${field.type})`);
    changed++;
  }

  console.log(
    changed === 0
      ? `Table "${TABLE_NAME}" (${table.id}) already matches the schema.`
      : `Updated "${TABLE_NAME}" (${table.id}): ${changed} change(s). Run "npm run sync -- --full" to backfill.`,
  );

  await ensureItems(baseId, tables, table.id);
}

/** Receipt line items. Created last, since it links back to Transactions. */
async function ensureItems(
  baseId: string,
  tables: Array<{ name: string }>,
  transactionsTableId: string,
) {
  if (tables.some((t) => t.name === ITEMS_TABLE)) return;
  const created = await createTable(baseId, {
    name: ITEMS_TABLE,
    description: "One row per line on a receipt, linked to its transaction.",
    fields: [
      { name: ITEM_NAME_FIELD, type: "singleLineText" },
      { name: ITEM_COST_FIELD, type: "currency", options: { precision: 2, symbol: "$" } },
      {
        name: ITEMS_TRANSACTION_FIELD,
        type: "multipleRecordLinks",
        options: { linkedTableId: transactionsTableId },
      },
    ],
  });
  console.log(`Created table "${created.name}" (${created.id}).`);
}

// Only run when invoked directly — sync.ts imports TABLE_NAME from here.
if (process.argv[1]?.endsWith("setup-airtable.ts")) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
