import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { describe, expect, test } from "vitest";

import {
  archiveRecord,
  executeIdempotentAuditCommand,
  IdempotencyConflictError,
  listActivePatients,
  OptimisticLockError,
  purgeExpiredAuditEntries,
  restoreRecord,
  setAuditRetentionPolicy,
  updatePatientIdentity,
} from "../src/db/integrity";
import * as schema from "../src/db/schema";
import { migrate } from "../scripts/migrate";
import { withEmptyTestDatabase } from "./helpers/database";

const patientId = "00000000-0000-7000-8000-000000000101";
const auditEntityId = "00000000-0000-7000-8000-000000000102";

async function seedPatient(client: Client, id = patientId): Promise<void> {
  await client.query(
    "INSERT INTO crm.patients (id, family_name, given_name, created_at, updated_at) VALUES ($1, 'Тестов', 'Пациент', now(), now())",
    [id],
  );
}

function database(client: Client) {
  return drizzle(client, { schema });
}

function databaseUrlWithApplicationName(databaseUrl: string, applicationName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const patientReadGateLock = 5139026004;

async function waitForLock(observer: Client, applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await observer.query<{ count: string }>("SELECT count(*) FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [applicationName]);
    if (activity.rows[0]?.count === "1") return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${applicationName} to block on the patient read gate.`);
}

async function installPatientReadGate(admin: Client): Promise<void> {
  await admin.query(`
    CREATE FUNCTION crm.test_pause_patient_read()
    RETURNS boolean
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF current_setting('application_name', true) IN ('integrity-patient-second', 'integrity-restore-second') THEN
        PERFORM pg_advisory_lock(${patientReadGateLock});
        PERFORM pg_advisory_unlock(${patientReadGateLock});
      END IF;
      RETURN true;
    END;
    $$
  `);
  await admin.query("GRANT EXECUTE ON FUNCTION crm.test_pause_patient_read() TO crm_runtime");
  await admin.query("ALTER TABLE crm.patients ENABLE ROW LEVEL SECURITY");
  await admin.query("CREATE POLICY integrity_patient_read_gate ON crm.patients FOR ALL TO crm_runtime USING (crm.test_pause_patient_read()) WITH CHECK (crm.test_pause_patient_read())");
}

describe("integrity foundation", () => {
  test("rolls back the business write, audit, and idempotency claim when a composite command fails", async () => {
    await withEmptyTestDatabase(async ({ adminUrl, migrationUrl, runtimeUrl }) => {
      await migrate(migrationUrl);
      const admin = new Client({ connectionString: adminUrl });
      const runtime = new Client({ connectionString: runtimeUrl });
      await admin.connect();
      await runtime.connect();
      try {
        await expect(
          executeIdempotentAuditCommand(database(runtime), {
            idempotency: { scope: "appointments", operation: "create", key: "rollback-key", request: { patientId } },
            audit: { action: "appointment.created", category: "scheduling", viewScope: "schedule", entityType: "appointment", entityId: auditEntityId, reason: "проверка отката" },
            execute: async (transaction) => {
              await transaction.insert(schema.patients).values({
                id: patientId,
                familyName: "Сбой",
                givenName: "Тест",
                createdAt: new Date(),
                updatedAt: new Date(),
              });
              throw new Error("artificial failure");
            },
          }),
        ).rejects.toThrow("artificial failure");

        await expect(runtime.query("SELECT count(*) FROM crm.patients WHERE id = $1", [patientId])).resolves.toMatchObject({ rows: [{ count: "0" }] });
        await expect(runtime.query("SELECT count(*) FROM crm.audit_entries")).resolves.toMatchObject({ rows: [{ count: "0" }] });
        await expect(admin.query("SELECT count(*) FROM crm.idempotency_keys")).resolves.toMatchObject({ rows: [{ count: "0" }] });
      } finally {
        await runtime.end();
        await admin.end();
      }
    });
  }, 90_000);

  test("replays a completed command exactly once, rejects a different payload, and serializes concurrent duplicates", async () => {
    await withEmptyTestDatabase(async ({ migrationUrl, runtimeUrl }) => {
      await migrate(migrationUrl);
      const first = new Client({ connectionString: runtimeUrl });
      const second = new Client({ connectionString: runtimeUrl });
      await first.connect();
      await second.connect();
      try {
        let executions = 0;
        let firstExecutionStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
          firstExecutionStarted = resolve;
        });
        const command = {
          idempotency: { scope: "appointments", operation: "create", key: "same-command", request: { patientId } },
          audit: { action: "appointment.created", category: "scheduling", viewScope: "schedule", entityType: "appointment", entityId: auditEntityId, reason: "повтор команды" },
        };
        const firstResult = executeIdempotentAuditCommand(database(first), {
          ...command,
          execute: async (transaction) => {
            executions += 1;
            firstExecutionStarted?.();
            await transaction.execute(sql`SELECT pg_sleep(0.08)`);
            await transaction.insert(schema.patients).values({
              id: patientId,
              familyName: "Первый",
              givenName: "Пациент",
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            return { statusCode: 201, response: { id: patientId } };
          },
        });
        await started;
        const secondResult = executeIdempotentAuditCommand(database(second), {
          ...command,
          execute: async () => {
            executions += 1;
            return { statusCode: 201, response: { id: "must-not-run" } };
          },
        });

        await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([
          { replayed: false, statusCode: 201, response: { id: patientId } },
          { replayed: true, statusCode: 201, response: { id: patientId } },
        ]);
        expect(executions).toBe(1);
        await expect(runtimeCount(first, "crm.patients")).resolves.toBe(1);
        await expect(runtimeCount(first, "crm.audit_entries")).resolves.toBe(1);

        await expect(
          executeIdempotentAuditCommand(database(first), {
            ...command,
            idempotency: { ...command.idempotency, request: { patientId, source: "different" } },
            execute: async () => ({ statusCode: 201, response: { id: "must-not-run" } }),
          }),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);
      } finally {
        await second.end();
        await first.end();
      }
    });
  }, 90_000);

  test("uses an atomic version check and returns current state for stale patient edits", async () => {
    await withEmptyTestDatabase(async ({ migrationUrl, runtimeUrl }) => {
      await migrate(migrationUrl);
      const runtime = new Client({ connectionString: runtimeUrl });
      await runtime.connect();
      try {
        await seedPatient(runtime);
        await expect(
          updatePatientIdentity(database(runtime), {
            patientId,
            expectedVersion: 1,
            familyName: "Обновлён",
            givenName: "Пациент",
            audit: { actorEmployeeId: null, reason: "исправление", viewScope: "patient", category: "patient" },
          }),
        ).resolves.toMatchObject({ version: 2, familyName: "Обновлён" });

        let staleError: unknown;
        try {
          await updatePatientIdentity(database(runtime), {
            patientId,
            expectedVersion: 1,
            familyName: "Устаревшее",
            givenName: "Пациент",
            audit: { actorEmployeeId: null, reason: "устаревшая форма", viewScope: "patient", category: "patient" },
          });
        } catch (error) {
          staleError = error;
        }
        expect(staleError).toBeInstanceOf(OptimisticLockError);
        expect((staleError as OptimisticLockError).current).toMatchObject({ version: 2, familyName: "Обновлён" });
      } finally {
        await runtime.end();
      }
    });
  }, 90_000);

  test("keeps a concurrent patient audit before snapshot adjacent to its versioned update", async () => {
    await withEmptyTestDatabase(async ({ adminUrl, migrationUrl, runtimeUrl }) => {
      await migrate(migrationUrl);
      const observer = new Client({ connectionString: adminUrl });
      const gate = new Client({ connectionString: adminUrl });
      const first = new Client({ connectionString: databaseUrlWithApplicationName(runtimeUrl, "integrity-patient-first") });
      const second = new Client({ connectionString: databaseUrlWithApplicationName(runtimeUrl, "integrity-patient-second") });
      let gateHeld = false;
      let secondUpdate: Promise<unknown> | undefined;
      await observer.connect();
      await gate.connect();
      await first.connect();
      await second.connect();
      try {
        await seedPatient(observer);
        await installPatientReadGate(observer);
        await gate.query(`SELECT pg_advisory_lock(${patientReadGateLock})`);
        gateHeld = true;

        secondUpdate = updatePatientIdentity(database(second), {
          patientId,
          expectedVersion: 2,
          familyName: "Второй",
          givenName: "Пациент",
          audit: { actorEmployeeId: null, reason: "вторая конкурентная правка", viewScope: "patient", category: "patient" },
        });
        await waitForLock(observer, "integrity-patient-second");

        await expect(updatePatientIdentity(database(first), {
          patientId,
          expectedVersion: 1,
          familyName: "Первый",
          givenName: "Пациент",
          audit: { actorEmployeeId: null, reason: "первая конкурентная правка", viewScope: "patient", category: "patient" },
        })).resolves.toMatchObject({ version: 2, familyName: "Первый" });
        await gate.query(`SELECT pg_advisory_unlock(${patientReadGateLock})`);
        gateHeld = false;
        await expect(secondUpdate).resolves.toMatchObject({ version: 3, familyName: "Второй" });

        const audit = await observer.query<{ before: { familyName: string; givenName: string; version: number; archivedAt: string | null }; after: { familyName: string; givenName: string; version: number; archivedAt: string | null } }>("SELECT before, after FROM crm.audit_entries WHERE reason = 'вторая конкурентная правка'");
        expect(audit.rows).toEqual([{
          before: { familyName: "Первый", givenName: "Пациент", version: 2, archivedAt: null },
          after: { familyName: "Второй", givenName: "Пациент", version: 3, archivedAt: null },
        }]);
      } finally {
        if (gateHeld) await gate.query(`SELECT pg_advisory_unlock(${patientReadGateLock})`);
        if (secondUpdate !== undefined) await secondUpdate.catch(() => undefined);
        await second.end();
        await first.end();
        await gate.end();
        await observer.end();
      }
    });
  }, 90_000);

  test("archives through an allowlist, hides active records, restores them, and retains audit history", async () => {
    await withEmptyTestDatabase(async ({ migrationUrl, runtimeUrl }) => {
      await migrate(migrationUrl);
      const runtime = new Client({ connectionString: runtimeUrl });
      await runtime.connect();
      try {
        await seedPatient(runtime);
        await expect(
          archiveRecord(database(runtime), {
            entityType: "patient",
            entityId: patientId,
            expectedVersion: 1,
            audit: { actorEmployeeId: null, reason: "дубликат", viewScope: "patient", category: "patient" },
          }),
        ).resolves.toMatchObject({ id: patientId, version: 2, archivedAt: expect.any(Date) });
        await expect(listActivePatients(database(runtime))).resolves.toEqual([]);

        await expect(
          restoreRecord(database(runtime), {
            entityType: "patient",
            entityId: patientId,
            expectedVersion: 2,
            audit: { actorEmployeeId: null, reason: "проверено", viewScope: "patient", category: "patient" },
          }),
        ).resolves.toMatchObject({ id: patientId, version: 3, archivedAt: null });
        await expect(listActivePatients(database(runtime))).resolves.toMatchObject([{ id: patientId, version: 3 }]);
        await expect(runtime.query("SELECT action FROM crm.audit_entries ORDER BY occurred_at")).resolves.toMatchObject({ rows: [{ action: "patient.archived" }, { action: "patient.restored" }] });
      } finally {
        await runtime.end();
      }
    });
  }, 90_000);

  test("keeps a concurrent archive/restore audit before snapshot adjacent to its versioned update", async () => {
    await withEmptyTestDatabase(async ({ adminUrl, migrationUrl, runtimeUrl }) => {
      await migrate(migrationUrl);
      const observer = new Client({ connectionString: adminUrl });
      const gate = new Client({ connectionString: adminUrl });
      const archiveClient = new Client({ connectionString: databaseUrlWithApplicationName(runtimeUrl, "integrity-archive-first") });
      const restoreClient = new Client({ connectionString: databaseUrlWithApplicationName(runtimeUrl, "integrity-restore-second") });
      let gateHeld = false;
      let restore: Promise<unknown> | undefined;
      await observer.connect();
      await gate.connect();
      await archiveClient.connect();
      await restoreClient.connect();
      try {
        await seedPatient(observer);
        await installPatientReadGate(observer);
        await gate.query(`SELECT pg_advisory_lock(${patientReadGateLock})`);
        gateHeld = true;

        restore = restoreRecord(database(restoreClient), {
          entityType: "patient",
          entityId: patientId,
          expectedVersion: 2,
          audit: { actorEmployeeId: null, reason: "второе конкурентное восстановление", viewScope: "patient", category: "patient" },
        });
        await waitForLock(observer, "integrity-restore-second");

        await expect(archiveRecord(database(archiveClient), {
          entityType: "patient",
          entityId: patientId,
          expectedVersion: 1,
          audit: { actorEmployeeId: null, reason: "первая конкурентная архивация", viewScope: "patient", category: "patient" },
        })).resolves.toMatchObject({ version: 2, archivedAt: expect.any(Date) });
        await gate.query(`SELECT pg_advisory_unlock(${patientReadGateLock})`);
        gateHeld = false;
        await expect(restore).resolves.toMatchObject({ version: 3, archivedAt: null });

        const audit = await observer.query<{ before: { version: number; archivedAt: string | null }; after: { version: number; archivedAt: string | null } }>("SELECT before, after FROM crm.audit_entries WHERE reason = 'второе конкурентное восстановление'");
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0]).toMatchObject({
          before: { version: 2, archivedAt: expect.any(String) },
          after: { version: 3, archivedAt: null },
        });
      } finally {
        if (gateHeld) await gate.query(`SELECT pg_advisory_unlock(${patientReadGateLock})`);
        if (restore !== undefined) await restore.catch(() => undefined);
        await restoreClient.end();
        await archiveClient.end();
        await gate.end();
        await observer.end();
      }
    });
  }, 90_000);

  test("stores per-row retention expiry, preserves expired history, enforces retention versions, and denies runtime mutation", async () => {
    await withEmptyTestDatabase(async ({ adminUrl, migrationUrl, runtimeUrl }) => {
      await migrate(migrationUrl);
      const admin = new Client({ connectionString: adminUrl });
      const runtime = new Client({ connectionString: runtimeUrl });
      await admin.connect();
      await runtime.connect();
      try {
        await expect(
          setAuditRetentionPolicy(database(runtime), {
            expectedVersion: 0,
            retentionDays: 1,
            audit: { actorEmployeeId: null, reason: "политика", viewScope: "settings", category: "settings" },
          }),
        ).resolves.toMatchObject({ retentionDays: 1, version: 1 });
        await executeIdempotentAuditCommand(database(runtime), {
          idempotency: { scope: "payments", operation: "create", key: "expired-audit", request: { amount: 1 } },
          audit: {
            action: "payment.created",
            category: "financial",
            viewScope: "payments",
            entityType: "payment",
            entityId: auditEntityId,
            reason: "проверка срока хранения",
          },
          execute: async () => ({ statusCode: 201, response: { id: auditEntityId } }),
        });
        const expiryBeforeChange = await runtime.query<{ expires_at: Date }>("SELECT expires_at FROM crm.audit_entries WHERE action = 'payment.created'");
        expect(expiryBeforeChange.rows[0]?.expires_at).toBeInstanceOf(Date);
        await admin.query("UPDATE crm.audit_entries SET expires_at = '2020-01-02T00:00:00.000Z' WHERE action = 'payment.created'");

        await expect(
          setAuditRetentionPolicy(database(runtime), {
            expectedVersion: 1,
            retentionDays: 30,
            audit: { actorEmployeeId: null, reason: "новая политика", viewScope: "settings", category: "settings" },
          }),
        ).resolves.toMatchObject({ retentionDays: 30, version: 2 });
        const expiryAfterChange = await runtime.query<{ expires_at: Date }>("SELECT expires_at FROM crm.audit_entries WHERE action = 'payment.created'");
        expect(expiryAfterChange.rows[0]?.expires_at).toEqual(new Date("2020-01-02T00:00:00.000Z"));

        let staleError: unknown;
        try {
          await setAuditRetentionPolicy(database(runtime), {
            expectedVersion: 1,
            retentionDays: 90,
            audit: { actorEmployeeId: null, reason: "устаревшая policy", viewScope: "settings", category: "settings" },
          });
        } catch (error) {
          staleError = error;
        }
        expect(staleError).toBeInstanceOf(OptimisticLockError);
        expect((staleError as OptimisticLockError).current).toMatchObject({ retentionDays: 30, version: 2 });
        await expect(runtime.query("SELECT count(*) FROM crm.audit_entries WHERE action = 'audit_retention_policy.updated'")).resolves.toMatchObject({ rows: [{ count: "2" }] });
        await expect(runtime.query("SELECT * FROM crm.set_audit_retention_policy('00000000-0000-7000-8000-000000000003'::uuid, '00000000-0000-7000-8000-000000000151'::uuid, NULL, 90, 'без версии', NULL)")).rejects.toMatchObject({ code: "22023" });
        await expect(runtime.query("SELECT count(*) FROM crm.audit_entries WHERE action = 'audit_retention_policy.updated'")).resolves.toMatchObject({ rows: [{ count: "2" }] });

        await expect(runtime.query("UPDATE crm.audit_entries SET action = 'changed' WHERE action = 'payment.created'")).rejects.toMatchObject({ code: "42501" });
        await expect(runtime.query("DELETE FROM crm.audit_entries WHERE action = 'payment.created'")).rejects.toMatchObject({ code: "42501" });
        await expect(runtime.query("UPDATE crm.audit_retention_policies SET retention_days = 365")).rejects.toMatchObject({ code: "42501" });
        await expect(purgeExpiredAuditEntries(database(runtime))).resolves.toBe(1);
        await expect(runtime.query("SELECT count(*) FROM crm.audit_entries WHERE action = 'payment.created'")).resolves.toMatchObject({ rows: [{ count: "0" }] });
      } finally {
        await runtime.end();
        await admin.end();
      }
    });
  }, 90_000);

  test("uses database-owned audit timestamps and rejects missing critical reasons", async () => {
    await withEmptyTestDatabase(async ({ migrationUrl, runtimeUrl }) => {
      await migrate(migrationUrl);
      const runtime = new Client({ connectionString: runtimeUrl });
      await runtime.connect();
      try {
        await setAuditRetentionPolicy(database(runtime), {
          expectedVersion: 0,
          retentionDays: 1,
          audit: { actorEmployeeId: null, reason: "начальная policy", viewScope: "settings", category: "settings" },
        });
        const before = new Date();
        await runtime.query("INSERT INTO crm.audit_entries (id, occurred_at, action, category, view_scope, entity_type, entity_id, reason, expires_at) VALUES ($1, '2000-01-01T00:00:00.000Z', 'timestamp.spoof.backdated', 'settings', 'settings', 'test', $2, 'проверка timestamp', '2100-01-01T00:00:00.000Z')", ["00000000-0000-7000-8000-000000000130", auditEntityId]);
        await runtime.query("INSERT INTO crm.audit_entries (id, occurred_at, action, category, view_scope, entity_type, entity_id, reason, expires_at) VALUES ($1, '2100-01-01T00:00:00.000Z', 'timestamp.spoof.future', 'settings', 'settings', 'test', $2, 'проверка timestamp', '2000-01-01T00:00:00.000Z')", ["00000000-0000-7000-8000-000000000131", auditEntityId]);
        const after = new Date();
        const entries = await runtime.query<{ occurred_at: Date; expires_at: Date }>("SELECT occurred_at, expires_at FROM crm.audit_entries WHERE action LIKE 'timestamp.spoof.%' ORDER BY action");
        expect(entries.rows).toHaveLength(2);
        for (const entry of entries.rows) {
          expect(entry.occurred_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
          expect(entry.occurred_at.getTime()).toBeLessThanOrEqual(after.getTime());
          expect(entry.expires_at.getTime() - entry.occurred_at.getTime()).toBe(86_400_000);
        }
        await expect(runtime.query("INSERT INTO crm.audit_entries (id, occurred_at, action, category, view_scope, entity_type, entity_id, reason) VALUES ($1, now(), 'reason.missing', 'settings', 'settings', 'test', $2, '   ')", ["00000000-0000-7000-8000-000000000132", auditEntityId])).rejects.toMatchObject({ code: "23514" });
      } finally {
        await runtime.end();
      }
    });
  }, 90_000);

  test("prevents direct idempotency poisoning and requires a private completion capability", async () => {
    await withEmptyTestDatabase(async ({ adminUrl, migrationUrl, runtimeUrl }) => {
      await migrate(migrationUrl);
      const admin = new Client({ connectionString: adminUrl });
      const runtime = new Client({ connectionString: runtimeUrl });
      await admin.connect();
      await runtime.connect();
      try {
        await executeIdempotentAuditCommand(database(runtime), {
          idempotency: { scope: "payments", operation: "create", key: "protected-key", request: { amount: 1000 } },
          audit: { action: "payment.created", category: "financial", viewScope: "payments", entityType: "payment", entityId: auditEntityId, reason: "проверка state machine" },
          execute: async () => ({ statusCode: 201, response: { id: auditEntityId } }),
        });
        await expect(runtime.query("UPDATE crm.idempotency_keys SET state = 'pending'")).rejects.toMatchObject({ code: "42501" });
        await expect(runtime.query("INSERT INTO crm.idempotency_keys (id, scope, operation, key, request_fingerprint) VALUES ($1, 'payments', 'create', 'direct-pending', 'fingerprint')", ["00000000-0000-7000-8000-000000000140"])).rejects.toMatchObject({ code: "42501" });
        await expect(runtime.query("SELECT * FROM crm.idempotency_keys")).rejects.toMatchObject({ code: "42501" });
        await expect(runtime.query("SELECT * FROM crm.idempotency_completion_capabilities")).rejects.toMatchObject({ code: "42501" });

        const firstClaimId = "00000000-0000-7000-8000-000000000141";
        const secondClaimId = "00000000-0000-7000-8000-000000000142";
        const firstCapability = "a".repeat(64);
        const secondCapability = "b".repeat(64);
        await expect(runtime.query<{ claim_status: string }>("SELECT claim_status FROM crm.claim_idempotency_key($1, 'payments', 'create', 'capability-first', 'fingerprint-first', $2)", [firstClaimId, firstCapability])).resolves.toMatchObject({ rows: [{ claim_status: "claimed" }] });
        await expect(runtime.query<{ claim_status: string }>("SELECT claim_status FROM crm.claim_idempotency_key($1, 'payments', 'create', 'capability-second', 'fingerprint-second', $2)", [secondClaimId, secondCapability])).resolves.toMatchObject({ rows: [{ claim_status: "claimed" }] });
        await expect(runtime.query("SELECT crm.complete_idempotency_key($1, 'payments', 'create', 'capability-first', 'fingerprint-first', $2, 201, '{\"id\": \"forged\"}'::jsonb)", [firstClaimId, secondCapability])).rejects.toMatchObject({ code: "P0001" });
        await expect(admin.query("SELECT state, response FROM crm.idempotency_keys WHERE id = $1", [firstClaimId])).resolves.toMatchObject({ rows: [{ state: "pending", response: null }] });
        await expect(runtime.query("SELECT crm.complete_idempotency_key($1, 'payments', 'create', 'capability-first', 'fingerprint-first', $2, 201, '{\"id\": \"first\"}'::jsonb)", [firstClaimId, firstCapability])).resolves.toMatchObject({ rows: [{ complete_idempotency_key: "" }] });
        await expect(runtime.query("SELECT crm.complete_idempotency_key($1, 'payments', 'create', 'capability-second', 'fingerprint-second', $2, 201, '{\"id\": \"second\"}'::jsonb)", [secondClaimId, secondCapability])).resolves.toMatchObject({ rows: [{ complete_idempotency_key: "" }] });
        await expect(admin.query("SELECT state, response FROM crm.idempotency_keys WHERE id = $1", [firstClaimId])).resolves.toMatchObject({ rows: [{ state: "completed", response: { id: "first" } }] });
        await expect(admin.query("SELECT count(*) FROM crm.idempotency_completion_capabilities")).resolves.toMatchObject({ rows: [{ count: "0" }] });
        await admin.query("SET ROLE crm_owner");
        await expect(admin.query("UPDATE crm.idempotency_keys SET scope = 'tampered' WHERE key = 'protected-key'")).rejects.toMatchObject({ code: "23514" });
        await expect(admin.query("UPDATE crm.idempotency_keys SET state = 'pending' WHERE key = 'protected-key'")).rejects.toMatchObject({ code: "23514" });
        await admin.query("RESET ROLE");
      } finally {
        await runtime.end();
        await admin.end();
      }
    });
  }, 90_000);
});

async function runtimeCount(client: Client, table: "crm.patients" | "crm.audit_entries"): Promise<number> {
  const result = await client.query<{ count: string }>(`SELECT count(*) FROM ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}
