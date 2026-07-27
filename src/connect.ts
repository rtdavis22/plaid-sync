import { writeFileSync } from "node:fs";
import { CountryCode, Products } from "plaid";
import { plaid, reportAndExit } from "./plaid.js";

const SESSION_FILE = ".plaid-link-session.json";

async function main() {
  const { data } = await plaid.linkTokenCreate({
    user: { client_user_id: "rob" },
    client_name: "Personal Airtable Transaction Sync",
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: "en",
    // Ask Plaid to host the Link UI so we don't need a frontend.
    hosted_link: {},
  });

  if (!data.hosted_link_url) {
    throw new Error(
      "Plaid did not return a hosted_link_url. Hosted Link may not be enabled for this account.",
    );
  }

  // exchange.ts needs the link_token to look the session up afterwards.
  writeFileSync(
    SESSION_FILE,
    JSON.stringify({ link_token: data.link_token, expiration: data.expiration }, null, 2),
  );

  console.log("Open this URL and connect your Chase card:\n");
  console.log(`  ${data.hosted_link_url}\n`);
  console.log(`Link token saved to ${SESSION_FILE} (expires ${data.expiration}).`);
  console.log("When Chase says the connection succeeded, run: npm run exchange");
}

main().catch(reportAndExit);
