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
import {
  ITEM_COST_FIELD,
  ITEM_DESCRIPTION_FIELD,
  ITEM_NAME_FIELD,
  ITEMS_LINK_FIELD,
  ITEMS_TABLE,
  ITEMS_TRANSACTION_FIELD,
} from "./receipts-schema.js";
import { PROCESSED_FIELD, TABLE_NAME } from "./setup-airtable.js";

const RECEIPT_FIELD = "Receipt";

/** Anything else (HEIC, TIFF) is skipped rather than sent and rejected. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

type Attachment = { id: string; url: string; filename: string; type: string };

type Extraction = {
  items: Array<{ name: string; description: string; cost: number }>;
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
          description: {
            type: "string",
            description: "The same item in plain English, abbreviations expanded.",
          },
          cost: { type: "number", description: "Price actually charged, after any line discount." },
        },
        required: ["name", "description", "cost"],
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

For each item give two forms of the name:

- "name": exactly as printed, abbreviations and all. Do not expand or tidy it.
- "description": the same item in plain English — expand the abbreviations into the
  product a person would recognise. "SIG TACO SHLLS YLW" is "Signature Select Yellow
  Taco Shells"; "BH VT YLW CHDR CHS" is "Vermont Yellow Cheddar Cheese". Keep it to a
  product name, not a sentence, and do not add detail the receipt does not support —
  no invented brands, sizes, or quantities. Where an abbreviation is genuinely unclear,
  expand only the part you are confident about and leave the rest as printed; a
  description close to the original is better than a confident guess.

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
  const items = tables.find((t) => t.name === ITEMS_TABLE);
  if (!transactions || !items) {
    throw new Error(`Need "${TABLE_NAME}" and "${ITEMS_TABLE}" in ${baseId}. Run "npm run setup-airtable".`);
  }
  if (!transactions.fields.some((f) => f.name === PROCESSED_FIELD)) {
    throw new Error(`No "${PROCESSED_FIELD}" column. Run "npm run setup-airtable" first.`);
  }

  const rows = await listAllRecords(baseId, transactions.id, [
    "Name",
    "Date",
    "Amount",
    RECEIPT_FIELD,
    PROCESSED_FIELD,
    ITEMS_LINK_FIELD,
  ]);

  // Any category — a receipt is a receipt.
  const pending = rows.filter((r) => {
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
        console.log(`    ${money(item.cost).padStart(9)}  ${item.name.padEnd(22)} ${item.description}`);
      }

      // Tax and rounding mean this rarely matches to the cent; a large gap
      // means misread digits, missed lines, or a discount applied at payment.
      // Logged on stdout, and labelled: stderr interleaves unpredictably in CI,
      // which can print a warning next to the wrong receipt.
      const expected = result.total ?? charged;
      if (Math.abs(expected - charged) > 0.02) {
        console.log(
          `  ⚠ ${label}: receipt total ${money(expected)} ≠ charged ${money(charged)}` +
            ` (${money(expected - charged)} difference)`,
        );
      }

      if (dryRun) continue;

      // A replaced receipt supersedes what the previous read produced.
      const stale = (row.fields[ITEMS_LINK_FIELD] as string[] | undefined) ?? [];
      if (stale.length > 0) await deleteRecords(baseId, items.id, stale);

      await createRecords(
        baseId,
        items.id,
        result.items.map((item) => ({
          fields: {
            [ITEM_NAME_FIELD]: item.name,
            [ITEM_DESCRIPTION_FIELD]: item.description,
            [ITEM_COST_FIELD]: item.cost,
            [ITEMS_TRANSACTION_FIELD]: [row.id],
          },
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
