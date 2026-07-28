import { readFileSync } from "node:fs";
import { addItem } from "./item.js";
import { plaid, reportAndExit } from "./plaid.js";

const SESSION_FILE = ".plaid-link-session.json";

function readLinkToken(): string {
  const fromArg = process.argv[2];
  if (fromArg) return fromArg;
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf8")).link_token;
  } catch {
    throw new Error(`No ${SESSION_FILE}. Run "npm run connect" first, or pass the link token as an argument.`);
  }
}

async function main() {
  const linkToken = readLinkToken();
  const { data } = await plaid.linkTokenGet({ link_token: linkToken });

  // Newer integrations get results.item_add_results (supports multi-Item sessions);
  // some accounts still receive the deprecated on_success instead.
  const publicTokens = (data.link_sessions ?? []).flatMap((session) => {
    const fromResults = (session.results?.item_add_results ?? []).map((r) => r.public_token);
    if (fromResults.length > 0) return fromResults;
    return session.on_success ? [session.on_success.public_token] : [];
  });

  if (publicTokens.length === 0) {
    throw new Error(
      "No completed Link session found yet. Finish the flow in the browser, then re-run this.",
    );
  }

  for (const publicToken of publicTokens) {
    const { data: exchanged } = await plaid.itemPublicTokenExchange({ public_token: publicToken });
    const { isNew } = addItem({
      access_token: exchanged.access_token,
      item_id: exchanged.item_id,
    });

    const { data: accounts } = await plaid.accountsGet({ access_token: exchanged.access_token });
    console.log(`${isNew ? "Linked" : "Re-linked"} ${accounts.item.institution_id ?? "institution"}:`);
    for (const account of accounts.accounts) {
      console.log(`  ${account.name} (${account.subtype}) ····${account.mask ?? "????"}`);
    }
  }

  console.log(`\nSaved to .plaid-items.json. Keep it out of git.`);
  console.log('Run "npm run sync -- --full" to pull the new history.');
}

main().catch(reportAndExit);
