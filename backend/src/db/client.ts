import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import * as schema from "./schema";
import { withClosableClient } from "./lifecycle";

type HyperdriveBinding = Pick<Hyperdrive, "connectionString">;

async function createDatabaseClient(binding: HyperdriveBinding) {
  return new Client({ connectionString: binding.connectionString });
}

/**
 * A database connection belongs to a single Worker request. Do not cache this
 * client at module scope: Workers may reuse isolates across concurrent requests.
 */
async function openRequestDatabase(binding: HyperdriveBinding) {
  const client = await createDatabaseClient(binding);
  await client.connect();

  return {
    db: drizzle(client, { schema }),
    async close(): Promise<void> {
      await client.end();
    },
  };
}

export async function withRequestDatabase<T>(
  binding: HyperdriveBinding,
  callback: (database: Awaited<ReturnType<typeof openRequestDatabase>>["db"]) => Promise<T>,
): Promise<T> {
  const client = await createDatabaseClient(binding);
  return withClosableClient(client, async () => {
    const database = drizzle(client, { schema });
    return callback(database);
  });
}
