import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const backendDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const crmRoles = ["crm_owner", "crm_migrations", "crm_runtime"];

export type TestDatabase = { adminUrl: string; migrationUrl: string; runtimeUrl: string };

function requiredTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (value === undefined || value.trim() === "" || process.env.TEST_DATABASE_DISPOSABLE_CLUSTER !== "1") throw new Error("TEST_DATABASE_URL and TEST_DATABASE_DISPOSABLE_CLUSTER=1 are required for a disposable PostgreSQL cluster.");
  return value;
}

function roleUrl(databaseUrl: string, role: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function assertDisposableGuard(admin: Client): Promise<void> {
  const marker = await admin.query<{ marker: string | null }>("SELECT obj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()");
  if (marker.rows[0]?.marker !== "inmotion-task002-disposable") throw new Error("TEST_DATABASE_URL must point to a database with COMMENT 'inmotion-task002-disposable'.");
  const existingRoles = await admin.query<{ count: string }>("SELECT count(*) FROM pg_roles WHERE rolname = ANY($1::text[])", [crmRoles]);
  if (existingRoles.rows[0]?.count !== "0") throw new Error("Disposable cluster must not contain pre-existing CRM roles.");
}

export async function withEmptyTestDatabase(callback: (database: TestDatabase) => Promise<void>): Promise<void> {
  const adminUrl = requiredTestDatabaseUrl();
  const databaseName = `inmotion_002_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl });
  let guardPassed = false;
  let databaseCreated = false;
  let bootstrapAttempted = false;
  const ownedCrmRoles = new Set<string>();
  let probeCreated = false;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];

  try {
    await admin.connect();
    await assertDisposableGuard(admin);
    guardPassed = true;
    await admin.query(`CREATE DATABASE ${databaseName}`);
    databaseCreated = true;
    const databaseUrl = target.toString();
    bootstrapAttempted = true;
    await bootstrapDatabase(databaseUrl);
    for (const role of crmRoles) ownedCrmRoles.add(role);
    const convergenceProbe = new Client({ connectionString: databaseUrl });
    try {
      await convergenceProbe.connect();
      await convergenceProbe.query(`GRANT CREATE ON DATABASE ${databaseName} TO crm_runtime`);
      await convergenceProbe.query("GRANT CREATE ON SCHEMA public TO crm_runtime");
      await convergenceProbe.query("GRANT crm_runtime TO crm_owner");
      await convergenceProbe.query("CREATE ROLE crm_membership_probe NOLOGIN");
      probeCreated = true;
      await convergenceProbe.query("GRANT crm_owner TO crm_membership_probe");
    } finally {
      await convergenceProbe.end();
    }
    await bootstrapDatabase(databaseUrl);
    const targetAdmin = new Client({ connectionString: databaseUrl });
    try {
      await targetAdmin.connect();
      const migrationPassword = randomUUID();
      const runtimePassword = randomUUID();
      await targetAdmin.query(`ALTER ROLE crm_migrations PASSWORD '${migrationPassword}'`);
      await targetAdmin.query(`ALTER ROLE crm_runtime PASSWORD '${runtimePassword}'`);
      await callback({ adminUrl: databaseUrl, migrationUrl: roleUrl(databaseUrl, "crm_migrations", migrationPassword), runtimeUrl: roleUrl(databaseUrl, "crm_runtime", runtimePassword) });
    } finally {
      await targetAdmin.end();
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (guardPassed) {
      const attemptCleanup = async (operation: () => Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };
      if (bootstrapAttempted && ownedCrmRoles.size === 0) {
        await attemptCleanup(async () => {
          const roles = await admin.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])", [crmRoles]);
          for (const role of roles.rows) ownedCrmRoles.add(role.rolname);
        });
      }
      if (databaseCreated) await attemptCleanup(() => admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`).then(() => undefined));
      if (probeCreated) await attemptCleanup(() => admin.query("DROP ROLE crm_membership_probe").then(() => undefined));
      for (const role of ["crm_migrations", "crm_runtime", "crm_owner"]) {
        if (ownedCrmRoles.has(role)) await attemptCleanup(() => admin.query(`DROP ROLE ${role}`).then(() => undefined));
      }
      await attemptCleanup(async () => {
        const database = await admin.query<{ count: string }>("SELECT count(*) FROM pg_database WHERE datname = $1", [databaseName]);
        const roles = await admin.query<{ count: string }>("SELECT count(*) FROM pg_roles WHERE rolname = ANY($1::text[])", [[...crmRoles, "crm_membership_probe"]]);
        if (database.rows[0]?.count !== "0" || roles.rows[0]?.count !== "0") throw new Error("Disposable test cleanup verification failed.");
      });
    }
    try {
      await admin.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError !== undefined && cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], "Database test and cleanup both failed.");
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Database test cleanup failed.");
}

export async function bootstrapDatabase(databaseUrl: string): Promise<void> {
  const bootstrapSql = await readFile(join(backendDirectory, "drizzle", "bootstrap.sql"), "utf8");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try { await client.query(bootstrapSql); } finally { await client.end(); }
}
