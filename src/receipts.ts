import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import {
  createRecords,
  deleteRecords,
  listAllRecords,
  listTables,
  updateRecords,
  type AirtableRecord,
} from "./airtable.js";
import { CATEGORIES_TABLE, CATEGORY_FIELD, NAME_FIELD } from "./categories.js";
import { PROCESSED_FIELD, TABLE_NAME } from "./setup-airtable.js";

/** Only receipts on transactions in this category are read. */
const GROCERY_CATEGORY = "Groceries";

/**
 * Category names carry a sort prefix ("05-Groceries") so linked-record groups
 * order the way you want. Strip it before matching, so renumbering is safe.
 */
function categoryName(raw: unknown): string {
  return String(raw ?? "")
    .replace(/^\s*\d+\s*[-–—.)]\s*/, "")
    .trim()
    .toLowerCase();
}
const ITEMS_TABLE = "Grocery Items";
const RECEIPT_FIELD = "Receipt";
const ITEMS_LINK_FIELD = "Grocery Items";

/** Anything else (HEIC, TIFF) is skipped rather than sent and rejected. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

type Attachment = { id: string; url: string; filename: string; type: string };

type Extraction = {
  items: Array<{ name: string; cost: number }>;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
};

const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The line item exactly as printed on the receipt." },
          cost: { type: "number", description: "Price actually charged, after any line discount." },
        },
        required: ["name", "cost"],
        additionalProperties: false,
      },
    },
    subtotal: nullableNumber,
    tax: nullableNumber,
    total: nullableNumber,
  },
  required: ["items", "subtotal", "tax", "total"],
  additionalProperties: false,
};

const PROMPT = `Extract every purchased line item from this receipt.

Transcribe names exactly as printed, abbreviations and all — do not expand or tidy them.
Record the price actually charged for each item, so apply any per-item discount.
Exclude subtotal, tax, total, change, and loyalty lines from items; report subtotal, tax,
and total in their own fields, or null if the receipt does not show them.
If the receipt spans several images, treat them as one continuous receipt.`;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Config error: missing ${name}.`);
    process.exit(1);
  }
  return value;
}

function attachmentsOf(record: AirtableRecord): Attachment[] {
  const raw = record.fields[RECEIPT_FIELD];
  return Array.isArray(raw) ? (raw as Attachment[]) : [];
}

/** Identity of the current receipt, so a replaced photo is reprocessed. */
function receiptKey(attachments: Attachment[]): string {
  return attachments.map((a) => a.id).join(",");
}

async function toContentBlock(attachment: Attachment) {
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Could not download ${attachment.filename}: ${response.status}`);
  }
  const data = Buffer.from(await response.arrayBuffer()).toString("base64");

  if (IMAGE_TYPES.has(attachment.type)) {
    return {
      type: "image" as const,
      source: { type: "base64" as const, media_type: attachment.type as never, data },
    };
  }
  if (attachment.type === "application/pdf") {
    return {
      type: "document" as const,
      source: { type: "base64" as const, media_type: "application/pdf" as const, data },
    };
  }
  throw new Error(`Unsupported receipt type ${attachment.type} (${attachment.filename})`);
}

async function extract(client: Anthropic, attachments: Attachment[]): Promise<Extraction> {
  const blocks = await Promise.all(attachments.map(toContentBlock));

  const response = await client.beta.messages.create({
    model: "claude-opus-5",
    max_tokens: 16000,
    // Reading printed text is bounded work; low effort is accurate and cheaper.
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    // Recommended default on Opus 5: a policy decline is retried on another model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{ role: "user", content: [...blocks, { type: "text", text: PROMPT }] }],
  } as never);

  const message = response as Anthropic.Beta.BetaMessage;
  if (message.stop_reason === "refusal") {
    throw new Error("Claude declined to read this receipt.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Ran out of output tokens — receipt may be unusually long.");
  }

  const text = message.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("No text block in response.");
  return JSON.parse(text.text) as Extraction;
}

const money = (n: number) => `$${n.toFixed(2)}`;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const baseId = requireEnv("AIRTABLE_BASE_ID");
  const client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });

  const { tables } = await listTables(baseId);
  const transactions = tables.find((t) => t.name === TABLE_NAME);
  const categories = tables.find((t) => t.name === CATEGORIES_TABLE);
  const items = tables.find((t) => t.name === ITEMS_TABLE);
  if (!transactions || !categories || !items) {
    throw new Error(`Need "${TABLE_NAME}", "${CATEGORIES_TABLE}" and "${ITEMS_TABLE}" in ${baseId}.`);
  }
  if (!transactions.fields.some((f) => f.name === PROCESSED_FIELD)) {
    throw new Error(`No "${PROCESSED_FIELD}" column. Run "npm run setup-airtable" first.`);
  }

  const groceryIds = new Set(
    (await listAllRecords(baseId, categories.id, [NAME_FIELD]))
      .filter((r) => categoryName(r.fields[NAME_FIELD]) === GROCERY_CATEGORY.toLowerCase())
      .map((r) => r.id),
  );
  if (groceryIds.size === 0) {
    throw new Error(`No "${GROCERY_CATEGORY}" row in ${CATEGORIES_TABLE}.`);
  }

  const rows = await listAllRecords(baseId, transactions.id, [
    "Name",
    "Date",
    "Amount",
    CATEGORY_FIELD,
    RECEIPT_FIELD,
    PROCESSED_FIELD,
    ITEMS_LINK_FIELD,
  ]);

  const pending = rows.filter((r) => {
    const linked = (r.fields[CATEGORY_FIELD] as string[] | undefined) ?? [];
    if (!linked.some((id) => groceryIds.has(id))) return false;
    const attachments = attachmentsOf(r);
    if (attachments.length === 0) return false;
    return r.fields[PROCESSED_FIELD] !== receiptKey(attachments);
  });

  console.log(`${pending.length} receipt(s) to read${dryRun ? " (dry run)" : ""}\n`);

  let failed = 0;
  for (const row of pending) {
    const label = `${row.fields.Date} ${row.fields.Name}`;
    const attachments = attachmentsOf(row);

    try {
      const result = await extract(client, attachments);
      const sum = result.items.reduce((n, i) => n + i.cost, 0);
      const charged = Number(row.fields.Amount ?? 0);

      console.log(`${label} — ${result.items.length} items, ${money(sum)} of ${money(charged)}`);
      for (const item of result.items) {
        console.log(`    ${money(item.cost).padStart(9)}  ${item.name}`);
      }

      // Tax and rounding mean this rarely matches to the cent; a large gap
      // means misread digits or missed lines, which is worth a human look.
      const expected = result.total ?? charged;
      if (Math.abs(expected - charged) > 0.02) {
        console.warn(`  ⚠ receipt total ${money(expected)} ≠ charged ${money(charged)}`);
      }

      if (dryRun) continue;

      // A replaced receipt supersedes what the previous read produced.
      const stale = (row.fields[ITEMS_LINK_FIELD] as string[] | undefined) ?? [];
      if (stale.length > 0) await deleteRecords(baseId, items.id, stale);

      await createRecords(
        baseId,
        items.id,
        result.items.map((item) => ({
          fields: { Name: item.name, Cost: item.cost, Transaction: [row.id] },
        })),
      );
      await updateRecords(baseId, transactions.id, [
        { id: row.id, fields: { [PROCESSED_FIELD]: receiptKey(attachments) } },
      ]);
    } catch (err) {
      failed++;
      console.error(`${label} — FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} receipt(s) failed.`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
