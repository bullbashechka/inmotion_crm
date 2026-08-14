import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { validateMigrationCatalog, validateMigrationJournal, type MigrationJournalEntry } from "../src/db/migration-journal";

const migrationLockKey = 5_139_026_002;
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
const noTransactionMarker = /^\s*--\s*inmotion:no-transaction\s*$/m;

export type Migration = { filename: string; sql: string; checksum: string; transactional: boolean };

function requiredDatabaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("DATABASE_MIGRATION_URL is required and must use the crm_migrations role.");
  }
  return value;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\r\n?/g, "\n");
}

export async function loadMigrations(): Promise<Migration[]> {
  const filenames = (await readdir(migrationsDirectory)).filter((filename) => /^\d{4}_.+\.sql$/.test(filename)).sort();
  const migrations = await Promise.all(filenames.map(async (filename) => {
    const sql = normalizeSql(await readFile(join(migrationsDirectory, filename), "utf8"));
    return { filename, sql, checksum: createHash("sha256").update(sql).digest("hex"), transactional: !noTransactionMarker.test(sql) };
  }));
  validateMigrationCatalog(migrations);
  return migrations;
}

async function assertMigrationRole(client: Client): Promise<void> {
  const result = await client.query<{ session_user: string; current_user: string }>("SELECT session_user, current_user");
  const identity = result.rows[0];
  if (identity?.session_user !== "crm_migrations" || identity.current_user !== "crm_migrations") {
    throw new Error("DATABASE_MIGRATION_URL must authenticate directly as crm_migrations.");
  }
}

export async function migrate(databaseUrl = requiredDatabaseUrl(process.env.DATABASE_MIGRATION_URL)): Promise<void> {
  const migrations = await loadMigrations();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await assertMigrationRole(client);
    await client.query("SELECT pg_advisory_lock($1)", [migrationLockKey]);
    await client.query("SET ROLE crm_owner");
    await client.query("SET TIME ZONE 'UTC'");
    const journal = await client.query<MigrationJournalEntry>("SELECT filename, checksum, state FROM crm_internal.schema_migrations ORDER BY filename");
    const applied = validateMigrationJournal(migrations, journal.rows);
    for (const migration of migrations) {
      const previousChecksum = applied.get(migration.filename);
      if (previousChecksum !== undefined) {
        if (previousChecksum !== migration.checksum) throw new Error(`Migration ${migration.filename} has changed after it was applied.`);
        continue;
      }
      if (!migration.transactional) {
        await client.query("INSERT INTO crm_internal.schema_migrations (filename, checksum, state, started_at) VALUES ($1, $2, 'running', now())", [migration.filename, migration.checksum]);
      } else await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        if (migration.transactional) {
          await client.query("INSERT INTO crm_internal.schema_migrations (filename, checksum, state, started_at, applied_at) VALUES ($1, $2, 'applied', now(), now())", [migration.filename, migration.checksum]);
          await client.query("COMMIT");
        } else await client.query("UPDATE crm_internal.schema_migrations SET state = 'applied', applied_at = now() WHERE filename = $1", [migration.filename]);
      } catch (error) {
        if (migration.transactional) await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [migrationLockKey]).catch(() => undefined);
    await client.end();
  }
}

if (import.meta.main) await migrate();
