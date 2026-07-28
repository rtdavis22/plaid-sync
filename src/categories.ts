import { listAllRecords } from "./airtable.js";

export const CATEGORIES_TABLE = "Categories";
export const NAME_FIELD = "Name";
export const MERCHANTS_FIELD = "Merchants";
/** The linked-record column on Transactions. */
export const CATEGORY_FIELD = "Category";

export type CategoryMatch = { id: string; name: string };

export type CategoryIndex = {
  /** Lower-cased merchant string → the category record it belongs to. */
  byMerchant: Map<string, CategoryMatch>;
  categories: number;
  merchants: number;
};

/** One merchant per line; commas also accepted so pasted lists work. */
function parseMerchants(value: unknown): string[] {
  return String(value ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
}

export async function loadCategories(baseId: string, tableId: string): Promise<CategoryIndex> {
  const records = await listAllRecords(baseId, tableId, [NAME_FIELD, MERCHANTS_FIELD]);
  const byMerchant = new Map<string, CategoryMatch>();

  for (const record of records) {
    const name = String(record.fields[NAME_FIELD] ?? "").trim();
    if (name === "") continue;

    for (const merchant of parseMerchants(record.fields[MERCHANTS_FIELD])) {
      const claimed = byMerchant.get(merchant);
      if (claimed && claimed.id !== record.id) {
        // Silently picking one would make the result depend on record order.
        console.warn(
          `"${merchant}" is listed under both "${claimed.name}" and "${name}" — keeping "${claimed.name}".`,
        );
        continue;
      }
      byMerchant.set(merchant, { id: record.id, name });
    }
  }

  return { byMerchant, categories: records.length, merchants: byMerchant.size };
}

/**
 * Exact match on the merchant, falling back to the raw bank description for the
 * ~5% of transactions Plaid cannot resolve to a merchant.
 */
export function categorize(
  merchant: string | null | undefined,
  name: string,
  index: CategoryIndex,
): CategoryMatch | undefined {
  for (const candidate of [merchant, name]) {
    const key = String(candidate ?? "").trim().toLowerCase();
    if (key === "") continue;
    const hit = index.byMerchant.get(key);
    if (hit) return hit;
  }
  return undefined;
}
