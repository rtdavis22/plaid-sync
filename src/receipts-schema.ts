/**
 * Shared between the receipt reader and the schema setup. Kept in its own
 * module so setup-airtable does not have to import receipts.ts, which runs on
 * import.
 */

/** One row per line on a receipt. */
export const ITEMS_TABLE = "Items";

/** The link back to Transactions, and the reverse link Airtable adds there. */
export const ITEMS_LINK_FIELD = "Items";
export const ITEMS_TRANSACTION_FIELD = "Transaction";

export const ITEM_NAME_FIELD = "Name";
export const ITEM_COST_FIELD = "Cost";
