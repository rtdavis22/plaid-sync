import { createField, createTable, listBases, listTables, renameField } from "./airtable.js";

export const TABLE_NAME = "Transactions";

/**
 * Set by hand only — sync reads it and never writes it. When a row has this
 * set, sync leaves that row's Amount alone. Clear it to hand the row back.
 */
export const OVERRIDE_FIELD = "Overridden From";

/**
 * Desired schema. Columns carrying Plaid's own inference or enrichment are
 * suffixed "(Plaid)"; columns reporting what the bank sent are not.
 *
 * Primary field first — Airtable makes field[0] primary, and an opaque ID is a
 * poor one. Order only matters when creating the table from scratch.
 */
const FIELDS = [
  { name: "Name", type: "singleLineText" },
  { name: "Date", type: "date", options: { dateFormat: { name: "iso" } } },
  { name: "Authorized Date", type: "date", options: { dateFormat: { name: "iso" } } },
  { name: "Amount", type: "currency", options: { precision: 2, symbol: "$" } },
  { name: "Card", type: "singleLineText" },
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
  // The dedupe key for upserts. Never edit this column by hand.
  { name: "Transaction ID", type: "singleLineText" },
];

/** Applied before adding missing fields, so a rename isn't mistaken for a new column. */
const RENAMES: Array<[from: string, to: string]> = [
  ["Category", "Category (Plaid)"],
  ["Merchant", "Merchant (Plaid)"],
  ["Override From", OVERRIDE_FIELD],
];

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
  const table = tables.find((t) => t.name === TABLE_NAME);

  if (!table) {
    const created = await createTable(baseId, {
      name: TABLE_NAME,
      description: "Credit card transactions synced from Plaid.",
      fields: FIELDS,
    });
    console.log(`Created table "${created.name}" (${created.id}) with ${FIELDS.length} fields.`);
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
}

// Only run when invoked directly — sync.ts imports TABLE_NAME from here.
if (process.argv[1]?.endsWith("setup-airtable.ts")) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
