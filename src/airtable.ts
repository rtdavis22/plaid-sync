import "dotenv/config";

const API = "https://api.airtable.com/v0";

function token(): string {
  const value = process.env.AIRTABLE_TOKEN;
  if (!value) {
    console.error("Config error: missing AIRTABLE_TOKEN. See README for how to create one.");
    process.exit(1);
  }
  return value;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`Airtable ${init.method ?? "GET"} ${path} → ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

export type AirtableRecord = { id: string; fields: Record<string, unknown> };

export function listBases() {
  return request<{ bases: Array<{ id: string; name: string; permissionLevel: string }> }>(
    "/meta/bases",
  );
}

export type AirtableField = { id: string; name: string; type: string };
export type AirtableTable = { id: string; name: string; fields: AirtableField[] };

export function listTables(baseId: string) {
  return request<{ tables: AirtableTable[] }>(`/meta/bases/${baseId}/tables`);
}

export function createField(baseId: string, tableId: string, body: unknown) {
  return request<AirtableField>(`/meta/bases/${baseId}/tables/${tableId}/fields`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Renaming preserves the field's data and id, so existing rows are untouched. */
export function renameField(baseId: string, tableId: string, fieldId: string, name: string) {
  return request<AirtableField>(`/meta/bases/${baseId}/tables/${tableId}/fields/${fieldId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function createTable(baseId: string, body: unknown) {
  return request<{ id: string; name: string }>(`/meta/bases/${baseId}/tables`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Fetch every record, following pagination. */
export async function listAllRecords(baseId: string, tableId: string, fields?: string[]) {
  const records: AirtableRecord[] = [];
  let offset: string | undefined;
  do {
    const params = new URLSearchParams();
    if (offset) params.set("offset", offset);
    for (const field of fields ?? []) params.append("fields[]", field);
    const page = await request<{ records: AirtableRecord[]; offset?: string }>(
      `/${baseId}/${tableId}?${params}`,
    );
    records.push(...page.records);
    offset = page.offset;
  } while (offset);
  return records;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Insert-or-update keyed on `mergeOn`, so re-running a sync is idempotent and a
 * pending charge that later posts updates in place instead of duplicating.
 */
export async function upsertRecords(
  baseId: string,
  tableId: string,
  mergeOn: string[],
  records: Array<{ fields: Record<string, unknown> }>,
) {
  let created = 0;
  let updated = 0;
  for (const batch of chunk(records, 10)) {
    const result = await request<{ createdRecords?: string[]; updatedRecords?: string[] }>(
      `/${baseId}/${tableId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          performUpsert: { fieldsToMergeOn: mergeOn },
          records: batch,
          typecast: true,
        }),
      },
    );
    created += result.createdRecords?.length ?? 0;
    updated += result.updatedRecords?.length ?? 0;
  }
  return { created, updated };
}

export async function createRecords(
  baseId: string,
  tableId: string,
  records: Array<{ fields: Record<string, unknown> }>,
) {
  const created: AirtableRecord[] = [];
  for (const batch of chunk(records, 10)) {
    const result = await request<{ records: AirtableRecord[] }>(`/${baseId}/${tableId}`, {
      method: "POST",
      body: JSON.stringify({ records: batch, typecast: true }),
    });
    created.push(...result.records);
  }
  return created;
}

export async function updateRecords(
  baseId: string,
  tableId: string,
  records: Array<{ id: string; fields: Record<string, unknown> }>,
) {
  for (const batch of chunk(records, 10)) {
    await request(`/${baseId}/${tableId}`, {
      method: "PATCH",
      body: JSON.stringify({ records: batch, typecast: true }),
    });
  }
}

export async function deleteRecords(baseId: string, tableId: string, recordIds: string[]) {
  let deleted = 0;
  for (const batch of chunk(recordIds, 10)) {
    const params = new URLSearchParams();
    for (const id of batch) params.append("records[]", id);
    const result = await request<{ records: Array<{ deleted: boolean }> }>(
      `/${baseId}/${tableId}?${params}`,
      { method: "DELETE" },
    );
    deleted += result.records.filter((r) => r.deleted).length;
  }
  return deleted;
}
