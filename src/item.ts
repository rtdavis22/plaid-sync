import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ITEMS_FILE = ".plaid-items.json";
/** Single-item layout used before Wells Fargo was added. Read once, then migrated. */
const LEGACY_FILE = ".plaid-item.json";

export type StoredItem = {
  access_token: string;
  item_id?: string;
  /** Per-item cursor: /transactions/sync cursors are not interchangeable. */
  cursor?: string;
};

function readFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function readItems(): StoredItem[] {
  const items = readFile(ITEMS_FILE);
  if (Array.isArray(items)) return items as StoredItem[];

  const legacy = readFile(LEGACY_FILE) as StoredItem | null;
  return legacy?.access_token ? [legacy] : [];
}

export function writeItems(items: StoredItem[]): void {
  writeFileSync(ITEMS_FILE, JSON.stringify(items, null, 2));
}

/** Adds an item, or refreshes the token if the same item is linked again. */
export function addItem(item: StoredItem): { items: StoredItem[]; isNew: boolean } {
  const items = readItems();
  const index = items.findIndex((i) => i.item_id && i.item_id === item.item_id);
  if (index >= 0) {
    // Re-linking invalidates the old cursor along with the old token.
    items[index] = { ...item };
    writeItems(items);
    return { items, isNew: false };
  }
  items.push(item);
  writeItems(items);
  return { items, isNew: true };
}

/**
 * In CI there is no item file — tokens arrive as a comma-separated secret.
 * Locally they come from the file that `npm run exchange` wrote.
 */
export function accessTokens(): string[] {
  const fromEnv = process.env.PLAID_ACCESS_TOKENS ?? process.env.PLAID_ACCESS_TOKEN;
  if (fromEnv) {
    const tokens = fromEnv.split(",").map((t) => t.trim()).filter(Boolean);
    if (tokens.length > 0) return tokens;
  }

  const tokens = readItems().map((i) => i.access_token).filter(Boolean);
  if (tokens.length === 0) {
    console.error(
      'Config error: no access tokens. Run "npm run exchange", or set PLAID_ACCESS_TOKENS.',
    );
    process.exit(1);
  }
  return tokens;
}

export function readCursor(accessToken: string): string | undefined {
  return readItems().find((i) => i.access_token === accessToken)?.cursor;
}

/** No-op when there is no item file (CI), since there is nowhere durable to write. */
export function writeCursor(accessToken: string, cursor: string): void {
  if (!existsSync(ITEMS_FILE) && !existsSync(LEGACY_FILE)) return;
  const items = readItems();
  const item = items.find((i) => i.access_token === accessToken);
  if (!item) return;
  item.cursor = cursor;
  writeItems(items);
}
