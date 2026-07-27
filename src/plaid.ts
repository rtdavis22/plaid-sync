import "dotenv/config";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

/** Config problems are user error, not bugs — report them without a stack trace. */
function configError(message: string): never {
  console.error(`Config error: ${message}`);
  process.exit(1);
}

function required(name: string): string {
  return process.env[name] || configError(`missing ${name}. Copy .env.example to .env and fill it in.`);
}

const env = (process.env.PLAID_ENV ?? "production") as keyof typeof PlaidEnvironments;
if (!(env in PlaidEnvironments)) {
  configError(`unknown PLAID_ENV "${env}". Use sandbox or production.`);
}

export const plaid = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": required("PLAID_CLIENT_ID"),
        "PLAID-SECRET": required("PLAID_SECRET"),
      },
    },
  }),
);

/** Plaid API errors carry the useful detail in response.data; ours carry it in message. */
export function reportAndExit(err: unknown): never {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data) console.error(data);
  else if (err instanceof Error) console.error(err.message);
  else console.error(err);
  process.exit(1);
}
