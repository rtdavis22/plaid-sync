import { listAllRecords } from "./airtable.js";

export const RULES_TABLE = "Category Rules";
export const MATCH_FIELD = "Match Text";
export const CATEGORY_FIELD = "Category";

export type Rule = { match: string; category: string };

/**
 * Sorted longest-match-first. That is the whole conflict-resolution story: the
 * more specific pattern wins, so there is no priority column to maintain.
 */
export async function loadRules(baseId: string, tableId: string): Promise<Rule[]> {
  const records = await listAllRecords(baseId, tableId, [MATCH_FIELD, CATEGORY_FIELD]);
  return records
    .map((r) => ({
      match: String(r.fields[MATCH_FIELD] ?? "").trim().toLowerCase(),
      category: String(r.fields[CATEGORY_FIELD] ?? "").trim(),
    }))
    .filter((r) => r.match !== "" && r.category !== "")
    .sort((a, b) => b.match.length - a.match.length);
}

/** Matches against the bank description and Plaid's cleaned merchant together. */
export function categorize(
  name: string,
  merchant: string | null | undefined,
  rules: Rule[],
): Rule | undefined {
  const haystack = `${name} ${merchant ?? ""}`.toLowerCase();
  return rules.find((rule) => haystack.includes(rule.match));
}
