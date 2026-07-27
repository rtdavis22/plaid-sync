import { createTable, listBases, listTables } from "./airtable.js";

export const TABLE_NAME = "Transactions";

/** Primary field first — Airtable makes field[0] the primary, and an opaque ID is a poor one. */
const FIELDS = [
  { name: "Name", type: "singleLineText" },
  { name: "Date", type: "date", options: { dateFormat: { name: "iso" } } },
  { name: "Amount", type: "currency", options: { precision: 2, symbol: "$" } },
  { name: "Card", type: "singleLineText" },
  { name: "Category", type: "singleLineText" },
  { name: "Pending", type: "checkbox", options: { color: "yellowBright", icon: "check" } },
  { name: "Merchant", type: "singleLineText" },
  // The dedupe key for upserts. Never edit this column by hand.
  { name: "Transaction ID", type: "singleLineText" },
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
  const existing = tables.find((t) => t.name === TABLE_NAME);
  if (existing) {
    console.log(`Table "${TABLE_NAME}" already exists (${existing.id}). Nothing to do.`);
    return;
  }

  const table = await createTable(baseId, {
    name: TABLE_NAME,
    description: "Credit card transactions synced from Plaid.",
    fields: FIELDS,
  });
  console.log(`Created table "${table.name}" (${table.id}) in ${baseId}.`);
}

// Only run when invoked directly — sync.ts imports TABLE_NAME from here.
if (process.argv[1]?.endsWith("setup-airtable.ts")) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
