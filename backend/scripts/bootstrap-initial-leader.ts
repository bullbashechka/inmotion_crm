import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { EmployeeService } from "../src/access/employees";
import { createAuthTokenCipher } from "../src/auth/crypto";
import { SupabaseAuthProvider } from "../src/auth/provider";
import { parseRuntimeConfig } from "../src/config";
import * as schema from "../src/db/schema";

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") throw new Error(`${name} обязателен.`);
  return value.trim();
}

const variables = process.env as Record<string, string | undefined>;
const config = parseRuntimeConfig(variables);
if (config.auth === undefined) throw new Error("Auth BFF должен быть полностью настроен перед bootstrap.");

const client = new Client({ connectionString: required(variables.DATABASE_BOOTSTRAP_URL, "DATABASE_BOOTSTRAP_URL") });
await client.connect();
try {
  const database = drizzle(client, { schema });
  const service = new EmployeeService({
    withDatabase: async (callback) => callback(database),
    provider: new SupabaseAuthProvider({
      url: config.auth.providerUrl,
      anonKey: config.auth.providerAnonKey,
      serviceRoleKey: config.auth.providerServiceRoleKey,
    }),
    tokenCipher: await createAuthTokenCipher(config.auth.tokenEncryptionKey),
    providerNamespace: config.auth.providerNamespace,
  });
  const created = await service.bootstrapInitialLeader({
    fullName: required(variables.INITIAL_LEADER_FULL_NAME, "INITIAL_LEADER_FULL_NAME"),
    contactEmail: required(variables.INITIAL_LEADER_CONTACT_EMAIL, "INITIAL_LEADER_CONTACT_EMAIL"),
    login: required(variables.INITIAL_LEADER_LOGIN, "INITIAL_LEADER_LOGIN"),
    reason: required(variables.INITIAL_LEADER_REASON, "INITIAL_LEADER_REASON"),
  });
  // This is the sole delivery of the password. Capture it in an approved secret
  // channel; do not store it in a shell history, ticket, or application log.
  console.log(JSON.stringify(created));
} finally {
  await client.end();
}
