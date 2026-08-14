import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";

import {
  appointmentSessions,
  appointments,
  auditEntries,
  auditRetentionPolicies,
  leads,
  medicalCases,
  patients,
  rooms,
  services,
} from "./schema";
import * as schema from "./schema";
import { createUuidV7 } from "./uuidv7";

export type RequestDatabase = NodePgDatabase<typeof schema>;
type IntegrityTransaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

export type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };

export type AuditEvent = {
  actorEmployeeId?: string | null;
  action: string;
  category: string;
  viewScope: string;
  entityType: string;
  entityId: string;
  reason: string;
  before?: JsonValue;
  after?: JsonValue;
};

export type AuditContext = Pick<AuditEvent, "actorEmployeeId" | "category" | "viewScope" | "reason">;

export type IdempotencyInput = {
  scope: string;
  operation: string;
  key: string;
  request: JsonValue;
};

export type IdempotentCommandResult<TResponse extends JsonValue> = {
  replayed: boolean;
  statusCode: number;
  response: TResponse;
};

export type IdempotentAuditCommand<TResponse extends JsonValue> = {
  idempotency: IdempotencyInput;
  audit: AuditEvent;
  execute: (transaction: IntegrityTransaction) => Promise<{ statusCode: number; response: TResponse }>;
};

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Ключ идемпотентности уже использован для другой команды.");
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyInProgressError extends Error {
  constructor() {
    super("Команда с этим ключом ещё выполняется. Повторите запрос позже.");
    this.name = "IdempotencyInProgressError";
  }
}

export class OptimisticLockError<TCurrent = unknown> extends Error {
  readonly current: TCurrent;

  constructor(current: TCurrent) {
    super("Запись уже изменилась. Получено её актуальное состояние.");
    this.name = "OptimisticLockError";
    this.current = current;
  }
}

const auditRetentionPolicyId = "00000000-0000-7000-8000-000000000003";

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function createIdempotencyCompletionCapability(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return hex(bytes.buffer);
}

export async function createRequestFingerprint(request: JsonValue): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(request));
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

export async function writeAuditEntry(transaction: IntegrityTransaction, event: AuditEvent): Promise<void> {
  await transaction.insert(auditEntries).values({
    id: createUuidV7(),
    actorEmployeeId: event.actorEmployeeId ?? null,
    action: event.action,
    category: event.category,
    viewScope: event.viewScope,
    entityType: event.entityType,
    entityId: event.entityId,
    reason: event.reason,
    before: event.before,
    after: event.after,
  });
}

/**
 * Runs claim, business changes, audit event, and stored terminal response in one
 * PostgreSQL transaction. A protected database function claims the key and a
 * private completion capability; a duplicate waits for the first transaction,
 * then receives the completed response instead of executing the command.
 */
export async function executeIdempotentAuditCommand<TResponse extends JsonValue>(
  database: RequestDatabase,
  command: IdempotentAuditCommand<TResponse>,
): Promise<IdempotentCommandResult<TResponse>> {
  const fingerprint = await createRequestFingerprint(command.idempotency.request);

  return database.transaction(async (transaction) => {
    const completionCapability = createIdempotencyCompletionCapability();
    const claimResult = await transaction.execute<{
      claimStatus: "claimed" | "completed" | "conflict" | "pending";
      id: string;
      responseStatus: number | null;
      response: JsonValue | null;
    }>(sql`
      SELECT
        claim_status AS "claimStatus",
        id,
        response_status AS "responseStatus",
        response
      FROM crm.claim_idempotency_key(
        ${createUuidV7()}::uuid,
        ${command.idempotency.scope}::text,
        ${command.idempotency.operation}::text,
        ${command.idempotency.key}::text,
        ${fingerprint}::text,
        ${completionCapability}::text
      )
    `);
    const claim = claimResult.rows[0];
    if (claim === undefined) throw new IdempotencyInProgressError();
    if (claim.claimStatus === "conflict") throw new IdempotencyConflictError();
    if (claim.claimStatus === "pending") throw new IdempotencyInProgressError();
    if (claim.claimStatus === "completed") {
      if (claim.responseStatus === null || claim.response === null) throw new IdempotencyInProgressError();
      return {
        replayed: true,
        statusCode: claim.responseStatus,
        response: claim.response as TResponse,
      };
    }

    const result = await command.execute(transaction);
    await writeAuditEntry(transaction, command.audit);
    await transaction.execute(sql`
      SELECT crm.complete_idempotency_key(
        ${claim.id}::uuid,
        ${command.idempotency.scope}::text,
        ${command.idempotency.operation}::text,
        ${command.idempotency.key}::text,
        ${fingerprint}::text,
        ${completionCapability}::text,
        ${result.statusCode}::integer,
        ${JSON.stringify(result.response)}::jsonb
      )
    `);

    return { replayed: false, ...result };
  });
}

export type PatientIdentityUpdate = {
  patientId: string;
  expectedVersion: number;
  familyName: string;
  givenName: string;
  audit: AuditContext;
};

type PatientIdentity = {
  id: string;
  familyName: string;
  givenName: string;
  version: number;
  archivedAt: Date | null;
};

function patientAuditSnapshot(patient: PatientIdentity): JsonValue {
  return {
    familyName: patient.familyName,
    givenName: patient.givenName,
    version: patient.version,
    archivedAt: patient.archivedAt?.toISOString() ?? null,
  };
}

export async function updatePatientIdentity(database: RequestDatabase, input: PatientIdentityUpdate): Promise<PatientIdentity> {
  return database.transaction(async (transaction) => {
    const before = await transaction
      .select({
        id: patients.id,
        familyName: patients.familyName,
        givenName: patients.givenName,
        version: patients.version,
        archivedAt: patients.archivedAt,
      })
      .from(patients)
      .where(eq(patients.id, input.patientId))
      .for("update")
      .limit(1);
    const lockedBefore = before[0];
    if (lockedBefore === undefined || lockedBefore.version !== input.expectedVersion) {
      throw new OptimisticLockError(lockedBefore ?? await findPatientIdentity(transaction, input.patientId));
    }
    const updated = await transaction
      .update(patients)
      .set({
        familyName: input.familyName,
        givenName: input.givenName,
        updatedAt: new Date(),
        version: sql`${patients.version} + 1`,
      })
      .where(and(eq(patients.id, input.patientId), eq(patients.version, input.expectedVersion)))
      .returning({
        id: patients.id,
        familyName: patients.familyName,
        givenName: patients.givenName,
        version: patients.version,
        archivedAt: patients.archivedAt,
    });
    const patient = updated[0];
    if (patient === undefined) {
      throw new OptimisticLockError(await findPatientIdentity(transaction, input.patientId));
    }
    await writeAuditEntry(transaction, {
      ...input.audit,
      action: "patient.updated",
      entityType: "patient",
      entityId: patient.id,
      before: patientAuditSnapshot(lockedBefore),
      after: patientAuditSnapshot(patient),
    });
    return patient;
  });
}

async function findPatientIdentity(transaction: IntegrityTransaction, patientId: string): Promise<PatientIdentity | null> {
  const current = await transaction
    .select({
      id: patients.id,
      familyName: patients.familyName,
      givenName: patients.givenName,
      version: patients.version,
      archivedAt: patients.archivedAt,
    })
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);
  return current[0] ?? null;
}

export type ArchiveEntityType = "patient" | "medicalCase" | "appointment" | "appointmentSession" | "lead" | "service" | "room";

export type ArchiveCommand = {
  entityType: ArchiveEntityType;
  entityId: string;
  expectedVersion: number;
  audit: AuditContext;
};

export type ArchivedRecord = { id: string; version: number; archivedAt: Date | null };

function archiveAuditSnapshot(record: ArchivedRecord): JsonValue {
  return { version: record.version, archivedAt: record.archivedAt?.toISOString() ?? null };
}

async function findArchivableRecord(
  transaction: IntegrityTransaction,
  entityType: ArchiveEntityType,
  entityId: string,
): Promise<ArchivedRecord | null> {
  switch (entityType) {
    case "patient": return (await transaction.select({ id: patients.id, version: patients.version, archivedAt: patients.archivedAt }).from(patients).where(eq(patients.id, entityId)).limit(1))[0] ?? null;
    case "medicalCase": return (await transaction.select({ id: medicalCases.id, version: medicalCases.version, archivedAt: medicalCases.archivedAt }).from(medicalCases).where(eq(medicalCases.id, entityId)).limit(1))[0] ?? null;
    case "appointment": return (await transaction.select({ id: appointments.id, version: appointments.version, archivedAt: appointments.archivedAt }).from(appointments).where(eq(appointments.id, entityId)).limit(1))[0] ?? null;
    case "appointmentSession": return (await transaction.select({ id: appointmentSessions.id, version: appointmentSessions.version, archivedAt: appointmentSessions.archivedAt }).from(appointmentSessions).where(eq(appointmentSessions.id, entityId)).limit(1))[0] ?? null;
    case "lead": return (await transaction.select({ id: leads.id, version: leads.version, archivedAt: leads.archivedAt }).from(leads).where(eq(leads.id, entityId)).limit(1))[0] ?? null;
    case "service": return (await transaction.select({ id: services.id, version: services.version, archivedAt: services.archivedAt }).from(services).where(eq(services.id, entityId)).limit(1))[0] ?? null;
    case "room": return (await transaction.select({ id: rooms.id, version: rooms.version, archivedAt: rooms.archivedAt }).from(rooms).where(eq(rooms.id, entityId)).limit(1))[0] ?? null;
  }
}

async function lockArchivableRecord(
  transaction: IntegrityTransaction,
  entityType: ArchiveEntityType,
  entityId: string,
): Promise<ArchivedRecord | null> {
  switch (entityType) {
    case "patient": return (await transaction.select({ id: patients.id, version: patients.version, archivedAt: patients.archivedAt }).from(patients).where(eq(patients.id, entityId)).for("update").limit(1))[0] ?? null;
    case "medicalCase": return (await transaction.select({ id: medicalCases.id, version: medicalCases.version, archivedAt: medicalCases.archivedAt }).from(medicalCases).where(eq(medicalCases.id, entityId)).for("update").limit(1))[0] ?? null;
    case "appointment": return (await transaction.select({ id: appointments.id, version: appointments.version, archivedAt: appointments.archivedAt }).from(appointments).where(eq(appointments.id, entityId)).for("update").limit(1))[0] ?? null;
    case "appointmentSession": return (await transaction.select({ id: appointmentSessions.id, version: appointmentSessions.version, archivedAt: appointmentSessions.archivedAt }).from(appointmentSessions).where(eq(appointmentSessions.id, entityId)).for("update").limit(1))[0] ?? null;
    case "lead": return (await transaction.select({ id: leads.id, version: leads.version, archivedAt: leads.archivedAt }).from(leads).where(eq(leads.id, entityId)).for("update").limit(1))[0] ?? null;
    case "service": return (await transaction.select({ id: services.id, version: services.version, archivedAt: services.archivedAt }).from(services).where(eq(services.id, entityId)).for("update").limit(1))[0] ?? null;
    case "room": return (await transaction.select({ id: rooms.id, version: rooms.version, archivedAt: rooms.archivedAt }).from(rooms).where(eq(rooms.id, entityId)).for("update").limit(1))[0] ?? null;
  }
}

async function updateArchiveState(
  transaction: IntegrityTransaction,
  entityType: ArchiveEntityType,
  entityId: string,
  expectedVersion: number,
  archivedAt: Date | null,
): Promise<ArchivedRecord | null> {
  const matchingArchiveState = archivedAt === null ? isNotNull : isNull;
  const values = { archivedAt, updatedAt: new Date(), version: sql`version + 1` };
  switch (entityType) {
    case "patient": return (await transaction.update(patients).set(values).where(and(eq(patients.id, entityId), eq(patients.version, expectedVersion), matchingArchiveState(patients.archivedAt))).returning({ id: patients.id, version: patients.version, archivedAt: patients.archivedAt }))[0] ?? null;
    case "medicalCase": return (await transaction.update(medicalCases).set(values).where(and(eq(medicalCases.id, entityId), eq(medicalCases.version, expectedVersion), matchingArchiveState(medicalCases.archivedAt))).returning({ id: medicalCases.id, version: medicalCases.version, archivedAt: medicalCases.archivedAt }))[0] ?? null;
    case "appointment": return (await transaction.update(appointments).set(values).where(and(eq(appointments.id, entityId), eq(appointments.version, expectedVersion), matchingArchiveState(appointments.archivedAt))).returning({ id: appointments.id, version: appointments.version, archivedAt: appointments.archivedAt }))[0] ?? null;
    case "appointmentSession": return (await transaction.update(appointmentSessions).set(values).where(and(eq(appointmentSessions.id, entityId), eq(appointmentSessions.version, expectedVersion), matchingArchiveState(appointmentSessions.archivedAt))).returning({ id: appointmentSessions.id, version: appointmentSessions.version, archivedAt: appointmentSessions.archivedAt }))[0] ?? null;
    case "lead": return (await transaction.update(leads).set(values).where(and(eq(leads.id, entityId), eq(leads.version, expectedVersion), matchingArchiveState(leads.archivedAt))).returning({ id: leads.id, version: leads.version, archivedAt: leads.archivedAt }))[0] ?? null;
    case "service": return (await transaction.update(services).set(values).where(and(eq(services.id, entityId), eq(services.version, expectedVersion), matchingArchiveState(services.archivedAt))).returning({ id: services.id, version: services.version, archivedAt: services.archivedAt }))[0] ?? null;
    case "room": return (await transaction.update(rooms).set(values).where(and(eq(rooms.id, entityId), eq(rooms.version, expectedVersion), matchingArchiveState(rooms.archivedAt))).returning({ id: rooms.id, version: rooms.version, archivedAt: rooms.archivedAt }))[0] ?? null;
  }
}

async function changeArchiveState(database: RequestDatabase, command: ArchiveCommand, archivedAt: Date | null): Promise<ArchivedRecord> {
  return database.transaction(async (transaction) => {
    const before = await lockArchivableRecord(transaction, command.entityType, command.entityId);
    const matchesArchiveState = before !== null && (archivedAt === null ? before.archivedAt !== null : before.archivedAt === null);
    if (before === null || before.version !== command.expectedVersion || !matchesArchiveState) {
      throw new OptimisticLockError(before ?? await findArchivableRecord(transaction, command.entityType, command.entityId));
    }
    const updated = await updateArchiveState(transaction, command.entityType, command.entityId, command.expectedVersion, archivedAt);
    if (updated === null) throw new OptimisticLockError(await findArchivableRecord(transaction, command.entityType, command.entityId));
    await writeAuditEntry(transaction, {
      ...command.audit,
      action: `${command.entityType}.${archivedAt === null ? "restored" : "archived"}`,
      entityType: command.entityType,
      entityId: command.entityId,
      before: archiveAuditSnapshot(before),
      after: archiveAuditSnapshot(updated),
    });
    return updated;
  });
}

/** Archiving is intentionally an allowlist rather than dynamic table-name SQL. */
export async function archiveRecord(database: RequestDatabase, command: ArchiveCommand): Promise<ArchivedRecord> {
  return changeArchiveState(database, command, new Date());
}

export async function restoreRecord(database: RequestDatabase, command: ArchiveCommand): Promise<ArchivedRecord> {
  return changeArchiveState(database, command, null);
}

export async function listActivePatients(database: RequestDatabase): Promise<PatientIdentity[]> {
  return database
    .select({
      id: patients.id,
      familyName: patients.familyName,
      givenName: patients.givenName,
      version: patients.version,
      archivedAt: patients.archivedAt,
    })
    .from(patients)
    .where(isNull(patients.archivedAt));
}

export type RetentionPolicyChange = {
  expectedVersion: number;
  retentionDays: number | null;
  audit: AuditContext;
};

export type AuditRetentionPolicy = {
  id: string;
  retentionDays: number | null;
  version: number;
};

/**
 * New retention policy values are stamped onto records that have not expired.
 * Expired rows keep their stored expiry and cannot be revived by a later policy.
 */
export async function setAuditRetentionPolicy(
  database: RequestDatabase,
  input: RetentionPolicyChange,
): Promise<AuditRetentionPolicy> {
  try {
    return await database.transaction(async (transaction) => {
      const policyChange = await transaction.execute<AuditRetentionPolicy>(sql`
        SELECT id, retention_days AS "retentionDays", version
        FROM crm.set_audit_retention_policy(
          ${auditRetentionPolicyId}::uuid,
          ${createUuidV7()}::uuid,
          ${input.audit.actorEmployeeId ?? null}::uuid,
          ${input.retentionDays}::integer,
          ${input.audit.reason}::text,
          ${input.expectedVersion}::integer
        )
      `);
      return policyChange.rows[0]!;
    });
  } catch (error) {
    if (!hasDatabaseErrorCode(error, "40001")) throw error;
    throw new OptimisticLockError(await readAuditRetentionPolicy(database));
  }
}

async function readAuditRetentionPolicy(database: RequestDatabase): Promise<AuditRetentionPolicy | null> {
  const policy = await database
    .select({ id: auditRetentionPolicies.id, retentionDays: auditRetentionPolicies.retentionDays, version: auditRetentionPolicies.version })
    .from(auditRetentionPolicies)
    .limit(1);
  return policy[0] ?? null;
}

function hasDatabaseErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === code) return true;
  return "cause" in error && hasDatabaseErrorCode(error.cause, code);
}

/** The no-argument database function can remove only records already expired by DB time. */
export async function purgeExpiredAuditEntries(database: RequestDatabase): Promise<number> {
  const result = await database.execute<{ purged_count: number }>(sql`SELECT crm.purge_expired_audit_entries() AS purged_count`);
  return Number(result.rows[0]?.purged_count ?? 0);
}
