import { readFileSync, writeFileSync } from "node:fs";

const ITEM_FILE = ".plaid-item.json";

type ItemFile = { access_token: string; item_id?: string; cursor?: string };

function readItemFile(): ItemFile | null {
  try {
    return JSON.parse(readFileSync(ITEM_FILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * In CI there is no item file — the token arrives as a secret. Locally it comes
 * from the file that `npm run exchange` wrote.
 */
export function accessToken(): string {
  const fromEnv = process.env.PLAID_ACCESS_TOKEN;
  if (fromEnv) return fromEnv;

  const item = readItemFile();
  if (!item?.access_token) {
    console.error(
      'Config error: no access token. Run "npm run exchange", or set PLAID_ACCESS_TOKEN.',
    );
    process.exit(1);
  }
  return item.access_token;
}

export function readCursor(): string | undefined {
  return readItemFile()?.cursor;
}

/** No-op when there is no item file (CI), since there is nowhere durable to write. */
export function writeCursor(cursor: string): void {
  const item = readItemFile();
  if (!item) return;
  writeFileSync(ITEM_FILE, JSON.stringify({ ...item, cursor }, null, 2));
}
