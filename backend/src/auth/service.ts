import { sql } from "drizzle-orm";

import type { AuthSession, AuthSessionState } from "@inmotion-crm/contracts";

import type { RequestDatabase } from "../db/integrity";
import { createUuidV7 } from "../db/uuidv7";
import { canonicalizeUsername, createOpaqueToken, createPkceChallenge, hashSecret, secretsEqual, type AuthTokenCipher } from "./crypto";
import type { AuthProvider, ProviderSession } from "./provider";

const idleWindowMs = 30 * 60 * 1000;
const warningWindowMs = 5 * 60 * 1000;
const absoluteWindowMs = 12 * 60 * 60 * 1000;
const providerReconciliationWindowMs = 30 * 60 * 1000;
const refreshReplayGraceMs = 10 * 1000;

type DatabaseRunner = <T>(callback: (database: RequestDatabase) => Promise<T>) => Promise<T>;

type DbTime = { now: Date };

type IdentityRow = {
  employeeId: string;
  employmentEpochId: string | null;
  employmentState: string;
  accessState: string | null;
  credentialState: string | null;
  temporaryPasswordExpiresAt: Date | null;
  loginFailureCount: number | null;
  loginFailureWindowStartedAt: Date | null;
  loginLockedUntil: Date | null;
  sessionEpoch: number | null;
  credentialEpoch: number | null;
  bindingId: string | null;
  providerSubjectId: string | null;
  providerNamespace: string | null;
  bindingState: string | null;
  recoveryEmail: string;
};

type ActiveIdentityRow = IdentityRow & {
  employmentEpochId: string;
  accessState: "active";
  credentialState: "ready" | "temporary_password" | "password_change_required";
  sessionEpoch: number;
  credentialEpoch: number;
  bindingId: string;
  providerSubjectId: string;
  bindingState: "active";
};

type SessionRow = {
  id: string;
  employeeId: string;
  employmentEpochId: string;
  authBindingId: string;
  providerSessionId: string;
  familyId: string;
  issuedSessionEpoch: number;
  issuedCredentialEpoch: number;
  accessTokenHash: string;
  refreshTokenHash: string;
  providerRefreshTokenCiphertext: string;
  lastInteractiveAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  status: string;
  revision: number;
  providerReconciledAt: Date | null;
  accessState: string;
  credentialState: string;
  currentSessionEpoch: number;
  currentCredentialEpoch: number;
  employmentState: string;
  bindingState: string;
  providerSubjectId: string;
  providerNamespace: string;
};

type RecoveryChallengeRow = {
  id: string;
  employeeId: string;
  employmentEpochId: string;
  authBindingId: string;
  credentialEpochAtIssue: number | null;
  stateVerifierHash: string;
  codeVerifierCiphertext: string;
  recoveryGrantHash: string | null;
  state: string;
  expiresAt: Date;
  grantExpiresAt: Date | null;
  providerSubjectId: string;
  providerNamespace: string;
  accessState: string;
  credentialState: string;
  currentCredentialEpoch: number;
  employmentState: string;
  bindingState: string;
};

type ProviderEffectRow = {
  id: string;
  operation: "auth_provider_session_revoke" | "auth_provider_user_ban";
  payload: unknown;
};

type RefreshReplayRow = {
  sessionId: string;
  familyId: string;
  successorCiphertext: string;
  consumedAt: Date;
};

export class AuthServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status: 401 | 403 | 409 | 423 | 503,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "AuthServiceError";
  }
}

export type IssuedSession = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  session: AuthSession;
};

type SignInFinalization =
  | { kind: "issued"; issued: IssuedSession }
  | { kind: "locked"; lockedUntil: Date; now: Date }
  | { kind: "temporary_password_already_used" }
  | { kind: "identity_mismatch" }
  | { kind: "identity_changed" };

export type AuthenticatedRequest = {
  employeeId: string;
  employmentEpochId: string;
  session: AuthSession;
  credentialState: "ready" | "password_change_required";
  sessionEpoch: number;
  credentialEpoch: number;
};

export type AuthServiceOptions = {
  withDatabase: DatabaseRunner;
  provider: AuthProvider;
  tokenCipher: AuthTokenCipher;
  providerNamespace: string;
  recoveryCallbackUrl: string;
  recoveryCompleteUrl: string;
  defer: (task: Promise<unknown>) => void;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function payloadString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null || !(key in payload)) return null;
  const value = Reflect.get(payload, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function waitForEnumerationFloor(startedAt: number): Promise<void> {
  const remaining = 150 - (Date.now() - startedAt);
  if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}

function sessionState(row: Pick<SessionRow, "lastInteractiveAt" | "idleExpiresAt" | "absoluteExpiresAt">, now: Date, credentialState: string): AuthSessionState {
  if (credentialState === "temporary_password" || credentialState === "password_change_required") return "password_change_required";
  const warningAt = Math.min(row.idleExpiresAt.getTime(), row.lastInteractiveAt.getTime() + idleWindowMs) - warningWindowMs;
  return now.getTime() >= warningAt ? "warning" : "active";
}

function toAuthSession(row: SessionRow, now: Date): AuthSession {
  const state = sessionState(row, now, row.credentialState);
  return {
    id: row.id,
    employeeId: row.employeeId,
    state,
    serverNow: now.toISOString(),
    warningAt: new Date(Math.min(row.idleExpiresAt.getTime(), row.lastInteractiveAt.getTime() + idleWindowMs) - warningWindowMs).toISOString(),
    idleExpiresAt: row.idleExpiresAt.toISOString(),
    absoluteExpiresAt: row.absoluteExpiresAt.toISOString(),
    revision: row.revision,
  };
}

async function databaseNow(database: RequestDatabase): Promise<Date> {
  const result = await database.execute<DbTime>(sql`SELECT clock_timestamp() AS now`);
  const now = result.rows[0]?.now;
  if (now === undefined) throw new Error("Database clock is unavailable.");
  return now;
}

function isActiveIdentity(identity: IdentityRow, now: Date): identity is ActiveIdentityRow {
  return identity.employmentState === "active"
    && identity.accessState === "active"
    && (identity.credentialState === "ready" || identity.credentialState === "temporary_password" || identity.credentialState === "password_change_required")
    && (identity.credentialState !== "temporary_password" || (identity.temporaryPasswordExpiresAt !== null && identity.temporaryPasswordExpiresAt.getTime() > now.getTime()))
    && identity.bindingState === "active"
    && identity.employmentEpochId !== null
    && identity.bindingId !== null
    && identity.providerSubjectId !== null
    && identity.sessionEpoch !== null
    && identity.credentialEpoch !== null
    && (identity.loginLockedUntil === null || identity.loginLockedUntil.getTime() <= now.getTime());
}

function genericSignInError(): AuthServiceError {
  return new AuthServiceError("INVALID_CREDENTIALS", 401, false, "Неверный логин или пароль.");
}

function lockError(lockedUntil: Date, serverNow: Date): AuthServiceError {
  const minutes = Math.max(1, Math.ceil((lockedUntil.getTime() - serverNow.getTime()) / 60_000));
  return new AuthServiceError("LOGIN_LOCKED", 423, false, `Вход временно заблокирован. Повторите через ${minutes} мин.`);
}

async function insertAttempt(
  database: RequestDatabase,
  input: { id: string; canonicalLogin: string; employeeId: string | null; outcome: string; providerAttempted: boolean },
): Promise<boolean> {
  const stale = await database.execute<{ id: string }>(sql`
    WITH expired AS (
      SELECT id
      FROM crm.auth_login_attempts
      WHERE outcome = 'processing'
        AND occurred_at <= clock_timestamp() - interval '2 minutes'
      ORDER BY occurred_at
      LIMIT 50
      FOR UPDATE SKIP LOCKED
    )
    UPDATE crm.auth_login_attempts AS attempt
    SET outcome = 'reconciliation_required'
    FROM expired
    WHERE attempt.id = expired.id
    RETURNING attempt.id
  `);
  for (const attempt of stale.rows) {
    await insertAudit(database, { actorEmployeeId: null, action: "auth.login.interrupted", entityType: "authLoginAttempt", entityId: attempt.id, reason: "processing_lease_expired" });
  }
  const inserted = await database.execute<{ id: string }>(sql`
    INSERT INTO crm.auth_login_attempts (id, canonical_login, employee_id, outcome, provider_attempted)
    VALUES (
      ${input.id}::uuid,
      ${input.canonicalLogin}::text,
      ${input.employeeId}::uuid,
      ${input.outcome}::text,
      ${input.providerAttempted ? 1 : 0}::integer
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `);
  return inserted.rows.length === 1;
}

async function completeAttempt(
  database: RequestDatabase,
  input: { id: string; employeeId: string | null; outcome: string; providerAttempted: boolean },
): Promise<boolean> {
  const updated = await database.execute<{ id: string }>(sql`
    UPDATE crm.auth_login_attempts
    SET employee_id = ${input.employeeId}::uuid,
        outcome = ${input.outcome}::text,
        provider_attempted = ${input.providerAttempted ? 1 : 0}::integer
    WHERE id = ${input.id}::uuid
      AND outcome = 'processing'
    RETURNING id
  `);
  return updated.rows.length === 1;
}

async function insertAudit(
  database: RequestDatabase,
  input: { actorEmployeeId?: string | null; action: string; entityType: string; entityId: string; reason: string; after?: Record<string, unknown> },
): Promise<void> {
  await database.execute(sql`
    INSERT INTO crm.audit_entries (
      id, actor_employee_id, action, category, view_scope,
      entity_type, entity_id, reason, after
    ) VALUES (
      ${createUuidV7()}::uuid,
      ${input.actorEmployeeId ?? null}::uuid,
      ${input.action}::text,
      'security'::text,
      'auth'::text,
      ${input.entityType}::text,
      ${input.entityId}::uuid,
      ${input.reason}::text,
      ${input.after === undefined ? null : JSON.stringify(input.after)}::jsonb
    )
  `);
}

async function findIdentityForLogin(database: RequestDatabase, canonicalLogin: string, lock = false): Promise<IdentityRow | null> {
  const result = await database.execute<IdentityRow>(sql`
    SELECT
      employee.id AS "employeeId",
      epoch.id AS "employmentEpochId",
      epoch.state AS "employmentState",
      security.access_state AS "accessState",
      security.credential_state AS "credentialState",
      security.temporary_password_expires_at AS "temporaryPasswordExpiresAt",
      security.login_failure_count AS "loginFailureCount",
      security.login_failure_window_started_at AS "loginFailureWindowStartedAt",
      security.login_locked_until AS "loginLockedUntil",
      security.session_epoch AS "sessionEpoch",
      security.credential_epoch AS "credentialEpoch",
      binding.id AS "bindingId",
      binding.provider_subject_id AS "providerSubjectId",
      binding.provider_namespace AS "providerNamespace",
      binding.state AS "bindingState",
      employee.recovery_email AS "recoveryEmail"
    FROM crm.login_claims AS claim
    JOIN crm.employment_epochs AS epoch ON epoch.id = claim.employment_epoch_id
    JOIN crm.employees AS employee ON employee.id = epoch.employee_id
    LEFT JOIN crm.employee_security_states AS security
      ON security.employee_id = employee.id AND security.employment_epoch_id = epoch.id
    LEFT JOIN crm.auth_bindings AS binding
      ON binding.employment_epoch_id = epoch.id AND binding.state = 'active'
    WHERE claim.canonical_login = ${canonicalLogin}::text
      AND claim.state = 'active'
    ORDER BY binding.confirmed_at DESC NULLS LAST
    LIMIT 1
    ${lock ? sql`FOR UPDATE OF claim, epoch, employee, security` : sql``}
  `);
  return result.rows[0] ?? null;
}

async function findSessionByHash(database: RequestDatabase, column: "access" | "refresh", tokenHash: string, lock = false): Promise<SessionRow | null> {
  const filter = column === "access"
    ? sql`session.access_token_hash = ${tokenHash}::text`
    : sql`session.refresh_token_hash = ${tokenHash}::text`;
  const result = await database.execute<SessionRow>(sql`
    SELECT
      session.id,
      session.employee_id AS "employeeId",
      session.employment_epoch_id AS "employmentEpochId",
      session.auth_binding_id AS "authBindingId",
      session.provider_session_id AS "providerSessionId",
      session.family_id AS "familyId",
      session.issued_session_epoch AS "issuedSessionEpoch",
      session.issued_credential_epoch AS "issuedCredentialEpoch",
      session.access_token_hash AS "accessTokenHash",
      session.refresh_token_hash AS "refreshTokenHash",
      session.provider_refresh_token_ciphertext AS "providerRefreshTokenCiphertext",
      session.last_interactive_at AS "lastInteractiveAt",
      session.idle_expires_at AS "idleExpiresAt",
      session.absolute_expires_at AS "absoluteExpiresAt",
      session.status,
      session.revision,
      session.provider_reconciled_at AS "providerReconciledAt",
      security.access_state AS "accessState",
      security.credential_state AS "credentialState",
      security.session_epoch AS "currentSessionEpoch",
      security.credential_epoch AS "currentCredentialEpoch",
      epoch.state AS "employmentState",
      binding.state AS "bindingState",
      binding.provider_subject_id AS "providerSubjectId"
      , binding.provider_namespace AS "providerNamespace"
    FROM crm.crm_sessions AS session
    JOIN crm.employee_security_states AS security ON security.employee_id = session.employee_id
    JOIN crm.employment_epochs AS epoch ON epoch.id = session.employment_epoch_id
    JOIN crm.auth_bindings AS binding ON binding.id = session.auth_binding_id
    WHERE ${filter}
    LIMIT 1
    ${lock ? sql`FOR UPDATE OF session, security, epoch, binding` : sql``}
  `);
  return result.rows[0] ?? null;
}

async function findRecoveryChallenge(database: RequestDatabase, challengeId: string, lock = false): Promise<RecoveryChallengeRow | null> {
  const result = await database.execute<RecoveryChallengeRow>(sql`
    SELECT
      challenge.id,
      challenge.employee_id AS "employeeId",
      challenge.employment_epoch_id AS "employmentEpochId",
      challenge.auth_binding_id AS "authBindingId",
      challenge.credential_epoch_at_issue AS "credentialEpochAtIssue",
      challenge.state_verifier_hash AS "stateVerifierHash",
      challenge.code_verifier_ciphertext AS "codeVerifierCiphertext",
      challenge.recovery_grant_hash AS "recoveryGrantHash",
      challenge.state,
      challenge.expires_at AS "expiresAt",
      challenge.grant_expires_at AS "grantExpiresAt",
      binding.provider_subject_id AS "providerSubjectId",
      binding.provider_namespace AS "providerNamespace",
      security.access_state AS "accessState",
      security.credential_state AS "credentialState",
      security.credential_epoch AS "currentCredentialEpoch",
      epoch.state AS "employmentState",
      binding.state AS "bindingState"
    FROM crm.auth_recovery_challenges AS challenge
    JOIN crm.employee_security_states AS security ON security.employee_id = challenge.employee_id
    JOIN crm.employment_epochs AS epoch ON epoch.id = challenge.employment_epoch_id
    JOIN crm.auth_bindings AS binding ON binding.id = challenge.auth_binding_id
    WHERE challenge.id = ${challengeId}::uuid
    LIMIT 1
    ${lock ? sql`FOR UPDATE OF challenge, security, epoch, binding` : sql``}
  `);
  return result.rows[0] ?? null;
}

function assertSessionUsable(row: SessionRow, now: Date, route: "crm_session" | "password_change", providerNamespace: string): void {
  if (
    row.status !== "active"
    || row.accessState !== "active"
    || row.employmentState !== "active"
    || row.bindingState !== "active"
    || row.providerNamespace !== providerNamespace
    || row.issuedSessionEpoch !== row.currentSessionEpoch
    || row.issuedCredentialEpoch !== row.currentCredentialEpoch
    || row.idleExpiresAt.getTime() <= now.getTime()
    || row.absoluteExpiresAt.getTime() <= now.getTime()
  ) throw new AuthServiceError("SESSION_EXPIRED", 401, false, "Сессия завершена. Войдите снова.");

  const requiresPasswordChange = row.credentialState === "temporary_password" || row.credentialState === "password_change_required";
  if (route === "crm_session" && requiresPasswordChange) {
    throw new AuthServiceError("PASSWORD_CHANGE_REQUIRED", 403, false, "Необходимо сменить временный пароль.");
  }
  if (route === "password_change" && !requiresPasswordChange && row.credentialState !== "ready") {
    throw new AuthServiceError("SESSION_NOT_ALLOWED", 403, false, "Эта сессия не может изменить пароль.");
  }
}

function assertProviderSessionMatches(identity: IdentityRow, providerSession: ProviderSession, expectedRecoveryEmail: string): void {
  if (identity.providerSubjectId !== providerSession.subjectId || providerSession.login !== expectedRecoveryEmail || !providerSession.authenticationMethods.includes("password")) {
    throw new AuthServiceError("IDENTITY_RECONCILIATION_REQUIRED", 409, false, "Учётная запись требует проверки безопасности.");
  }
}

export class AuthService {
  constructor(private readonly options: AuthServiceOptions) {}

  async signIn(input: { login: string; password: string; attemptId: string }): Promise<IssuedSession> {
    const canonicalLogin = canonicalizeUsername(input.login);
    if (canonicalLogin === null || !isUuid(input.attemptId)) {
      throw genericSignInError();
    }

    const preflight = await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const now = await databaseNow(transaction);
      const claimed = await insertAttempt(transaction, {
        id: input.attemptId,
        canonicalLogin,
        employeeId: null,
        outcome: "processing",
        providerAttempted: false,
      });
      if (!claimed) return { kind: "duplicate" as const };
      const identity = await findIdentityForLogin(transaction, canonicalLogin, true);
      if (identity === null) {
        await completeAttempt(transaction, { id: input.attemptId, employeeId: null, outcome: "invalid_credentials", providerAttempted: false });
        await insertAudit(transaction, { action: "auth.login.failed", entityType: "authLoginAttempt", entityId: input.attemptId, reason: "invalid_credentials" });
        return { kind: "invalid" as const };
      }
      if (identity.loginLockedUntil !== null && identity.loginLockedUntil.getTime() <= now.getTime()) {
        await transaction.execute(sql`
        UPDATE crm.employee_security_states
          SET login_failure_count = 0, login_failure_window_started_at = NULL, login_locked_until = NULL, updated_at = clock_timestamp(), version = version + 1
          WHERE employee_id = ${identity.employeeId}::uuid
        `);
        identity.loginFailureCount = 0;
        identity.loginLockedUntil = null;
      }
      if (identity.loginLockedUntil !== null && identity.loginLockedUntil.getTime() > now.getTime()) {
        await completeAttempt(transaction, { id: input.attemptId, employeeId: identity.employeeId, outcome: "locked", providerAttempted: false });
        await insertAudit(transaction, { actorEmployeeId: identity.employeeId, action: "auth.login.locked", entityType: "authLoginAttempt", entityId: input.attemptId, reason: "lock_active" });
        return { kind: "locked" as const, lockedUntil: identity.loginLockedUntil, now };
      }
      if (!isActiveIdentity(identity, now) || identity.providerNamespace !== this.options.providerNamespace) {
        await completeAttempt(transaction, { id: input.attemptId, employeeId: identity.employeeId, outcome: "inactive", providerAttempted: false });
        await insertAudit(transaction, { actorEmployeeId: identity.employeeId, action: "auth.login.denied", entityType: "authLoginAttempt", entityId: input.attemptId, reason: "identity_not_eligible" });
        return { kind: "invalid" as const };
      }
      if (identity.credentialState === "password_change_required") {
        await completeAttempt(transaction, { id: input.attemptId, employeeId: identity.employeeId, outcome: "invalid_credentials", providerAttempted: false });
        await insertAudit(transaction, { actorEmployeeId: identity.employeeId, action: "auth.login.denied", entityType: "authLoginAttempt", entityId: input.attemptId, reason: "temporary_password_already_used" });
        return { kind: "invalid" as const };
      }
      return { kind: "eligible" as const, identity };
    }));

    if (preflight.kind === "locked") throw lockError(preflight.lockedUntil, preflight.now);
    if (preflight.kind === "invalid") throw genericSignInError();
    if (preflight.kind === "duplicate") throw genericSignInError();

    const providerResult = await this.options.provider.signInWithPassword({ login: preflight.identity.recoveryEmail, password: input.password });
    if (providerResult.kind === "unavailable") {
      await this.recordAttempt(input.attemptId, canonicalLogin, preflight.identity.employeeId, "provider_unavailable", true, "auth.login.provider_unavailable");
      throw new AuthServiceError("AUTH_PROVIDER_UNAVAILABLE", 503, true, "Служба входа временно недоступна. Повторите попытку.");
    }
    if (providerResult.kind === "invalid_credentials") {
      await this.recordInvalidPasswordAttempt(input.attemptId, canonicalLogin, preflight.identity.employeeId);
      throw genericSignInError();
    }

    try {
      assertProviderSessionMatches(preflight.identity, providerResult.session, preflight.identity.recoveryEmail);
    } catch (error) {
      await this.recordAttempt(input.attemptId, canonicalLogin, preflight.identity.employeeId, "reconciliation_required", true, "auth.login.reconciliation_required");
      await this.quarantineIdentity(preflight.identity.employeeId, input.attemptId, "provider_identity_mismatch");
      await this.ensureProviderUserBanned(providerResult.session.subjectId, input.attemptId);
      throw error;
    }

    const accessToken = createOpaqueToken();
    const refreshToken = createOpaqueToken();
    const accessTokenHash = await hashSecret(accessToken);
    const refreshTokenHash = await hashSecret(refreshToken);
    let providerRefreshTokenCiphertext: string;
    try {
      providerRefreshTokenCiphertext = await this.options.tokenCipher.encrypt(providerResult.session.refreshToken);
    } catch {
      await this.recordAttempt(input.attemptId, canonicalLogin, preflight.identity.employeeId, "provider_unavailable", true, "auth.login.provider_token_encryption_failed");
      await this.ensureProviderSessionRevoked(providerResult.session.accessToken, input.attemptId);
      throw new AuthServiceError("AUTH_PROVIDER_UNAVAILABLE", 503, true, "Служба входа временно недоступна. Повторите попытку.");
    }

    let finalized: SignInFinalization;
    try {
      finalized = await this.options.withDatabase(async (database) => database.transaction(async (transaction): Promise<SignInFinalization> => {
      const now = await databaseNow(transaction);
      const identity = await findIdentityForLogin(transaction, canonicalLogin, true);
      if (identity !== null && identity.loginLockedUntil !== null && identity.loginLockedUntil.getTime() > now.getTime()) {
        await completeAttempt(transaction, { id: input.attemptId, employeeId: identity.employeeId, outcome: "locked", providerAttempted: true });
        await insertAudit(transaction, { actorEmployeeId: null, action: "auth.login.locked", entityType: "authLoginAttempt", entityId: input.attemptId, reason: "concurrent_lock" });
        return { kind: "locked" as const, lockedUntil: identity.loginLockedUntil, now };
      }
      if (identity === null || !isActiveIdentity(identity, now) || identity.providerNamespace !== this.options.providerNamespace) {
        await completeAttempt(transaction, { id: input.attemptId, employeeId: preflight.identity.employeeId, outcome: "reconciliation_required", providerAttempted: true });
        await insertAudit(transaction, { actorEmployeeId: null, action: "auth.login.reconciliation_required", entityType: "authLoginAttempt", entityId: input.attemptId, reason: "identity_changed_during_provider_call" });
        return { kind: "identity_changed" as const };
      }
      if (identity.credentialState === "password_change_required") {
        await completeAttempt(transaction, { id: input.attemptId, employeeId: identity.employeeId, outcome: "invalid_credentials", providerAttempted: true });
        await insertAudit(transaction, { actorEmployeeId: identity.employeeId, action: "auth.login.denied", entityType: "authLoginAttempt", entityId: input.attemptId, reason: "temporary_password_already_used" });
        return { kind: "temporary_password_already_used" as const };
      }
      try {
        assertProviderSessionMatches(identity, providerResult.session, identity.recoveryEmail);
      } catch {
        await completeAttempt(transaction, { id: input.attemptId, employeeId: identity.employeeId, outcome: "reconciliation_required", providerAttempted: true });
        await transaction.execute(sql`
          UPDATE crm.employee_security_states
          SET access_state = 'security_quarantined', session_epoch = session_epoch + 1,
              updated_at = clock_timestamp(), version = version + 1
          WHERE employee_id = ${identity.employeeId}::uuid
        `);
        await insertAudit(transaction, { actorEmployeeId: identity.employeeId, action: "auth.identity.quarantined", entityType: "authLoginAttempt", entityId: input.attemptId, reason: "post_provider_identity_mismatch" });
        return { kind: "identity_mismatch" as const };
      }
      if (identity.credentialState === "temporary_password") {
        const consumed = await transaction.execute<{ employeeId: string }>(sql`
          UPDATE crm.employee_security_states
          SET credential_state = 'password_change_required', temporary_password_expires_at = NULL,
              updated_at = clock_timestamp(), version = version + 1
          WHERE employee_id = ${identity.employeeId}::uuid
            AND employment_epoch_id = ${identity.employmentEpochId}::uuid
            AND credential_state = 'temporary_password'
          RETURNING employee_id AS "employeeId"
        `);
        if (consumed.rows[0] === undefined) throw genericSignInError();
        identity.credentialState = "password_change_required";
        identity.temporaryPasswordExpiresAt = null;
        await insertAudit(transaction, { actorEmployeeId: identity.employeeId, action: "auth.temporary_password.consumed", entityType: "employee", entityId: identity.employeeId, reason: "first_successful_sign_in" });
      }
      await transaction.execute(sql`
        UPDATE crm.employee_security_states
        SET login_failure_count = 0, login_failure_window_started_at = NULL, login_locked_until = NULL,
            updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${identity.employeeId}::uuid
          AND employment_epoch_id = ${identity.employmentEpochId}::uuid
      `);
      const sessionId = createUuidV7();
      const familyId = createUuidV7();
      const inserted = await transaction.execute<Pick<SessionRow, "id" | "employeeId" | "lastInteractiveAt" | "idleExpiresAt" | "absoluteExpiresAt" | "revision">>(sql`
        INSERT INTO crm.crm_sessions (
          id, employee_id, employment_epoch_id, auth_binding_id, provider_session_id,
          family_id, issued_session_epoch, issued_credential_epoch, access_token_hash,
          refresh_token_hash, provider_refresh_token_ciphertext, last_interactive_at,
          idle_expires_at, absolute_expires_at, provider_reconciled_at
        ) VALUES (
          ${sessionId}::uuid,
          ${identity.employeeId}::uuid,
          ${identity.employmentEpochId}::uuid,
          ${identity.bindingId}::uuid,
          ${providerResult.session.sessionId}::uuid,
          ${familyId}::uuid,
          ${identity.sessionEpoch}::integer,
          ${identity.credentialEpoch}::integer,
          ${accessTokenHash}::text,
          ${refreshTokenHash}::text,
          ${providerRefreshTokenCiphertext}::text,
          clock_timestamp(),
          clock_timestamp() + interval '30 minutes',
          clock_timestamp() + interval '12 hours',
          clock_timestamp()
        )
        RETURNING
          id,
          employee_id AS "employeeId",
          last_interactive_at AS "lastInteractiveAt",
          idle_expires_at AS "idleExpiresAt",
          absolute_expires_at AS "absoluteExpiresAt",
          revision
      `);
      const session = inserted.rows[0];
      if (session === undefined) throw new Error("CRM session was not created.");
      const attemptCompleted = await completeAttempt(transaction, { id: input.attemptId, employeeId: identity.employeeId, outcome: "succeeded", providerAttempted: true });
      if (!attemptCompleted) throw new AuthServiceError("LOGIN_ATTEMPT_ALREADY_USED", 409, false, "Эта попытка входа уже обработана. Повторите вход заново.");
      await insertAudit(transaction, { actorEmployeeId: identity.employeeId, action: "auth.login.succeeded", entityType: "crmSession", entityId: session.id, reason: "password_verified" });
      const completed: SessionRow = {
        ...session,
        employmentEpochId: identity.employmentEpochId,
        authBindingId: identity.bindingId,
        providerSessionId: providerResult.session.sessionId,
        familyId,
        issuedSessionEpoch: identity.sessionEpoch ?? 1,
        issuedCredentialEpoch: identity.credentialEpoch ?? 1,
        accessTokenHash,
        refreshTokenHash,
        providerRefreshTokenCiphertext,
        status: "active",
        providerReconciledAt: now,
        accessState: "active",
        credentialState: identity.credentialState ?? "ready",
        currentSessionEpoch: identity.sessionEpoch ?? 1,
        currentCredentialEpoch: identity.credentialEpoch ?? 1,
        employmentState: "active",
        bindingState: "active",
        providerSubjectId: providerResult.session.subjectId,
        providerNamespace: this.options.providerNamespace,
      };
      return { kind: "issued" as const, issued: {
        accessToken,
        accessTokenExpiresAt: session.idleExpiresAt.toISOString(),
        refreshToken,
        session: toAuthSession(completed, now),
      } };
      }));
    } catch (error) {
      await this.recordAttempt(input.attemptId, canonicalLogin, preflight.identity.employeeId, "reconciliation_required", true, "auth.login.finalization_interrupted").catch(() => undefined);
      await this.ensureProviderSessionRevoked(providerResult.session.accessToken, input.attemptId).catch(() => undefined);
      throw error;
    }
    if (finalized.kind === "issued") return finalized.issued;
    if (finalized.kind === "temporary_password_already_used") {
      await this.ensureProviderSessionRevoked(providerResult.session.accessToken, input.attemptId);
      throw genericSignInError();
    }
    if (finalized.kind === "identity_mismatch") {
      await this.ensureProviderUserBanned(providerResult.session.subjectId, input.attemptId);
      throw new AuthServiceError("IDENTITY_RECONCILIATION_REQUIRED", 409, false, "Учётная запись требует проверки безопасности.");
    }
    await this.ensureProviderSessionRevoked(providerResult.session.accessToken, input.attemptId);
    if (finalized.kind === "locked") throw lockError(finalized.lockedUntil, finalized.now);
    throw genericSignInError();
  }

  async authenticate(accessToken: string, route: "crm_session" | "password_change"): Promise<AuthenticatedRequest> {
    const tokenHash = await hashSecret(accessToken);
    let checked = await this.options.withDatabase(async (database) => {
      const now = await databaseNow(database);
      const session = await findSessionByHash(database, "access", tokenHash);
      if (session === null) throw new AuthServiceError("AUTHENTICATION_REQUIRED", 401, false, "Требуется действующая сессия CRM.");
      assertSessionUsable(session, now, route, this.options.providerNamespace);
      return { session, now };
    });

    if (checked.session.providerReconciledAt === null || checked.now.getTime() - checked.session.providerReconciledAt.getTime() >= providerReconciliationWindowMs) {
      checked = await this.reconcileProviderSession(tokenHash, route);
    }

    return {
      employeeId: checked.session.employeeId,
      employmentEpochId: checked.session.employmentEpochId,
      session: toAuthSession(checked.session, checked.now),
      credentialState: checked.session.credentialState === "ready" ? "ready" : "password_change_required",
      sessionEpoch: checked.session.currentSessionEpoch,
      credentialEpoch: checked.session.currentCredentialEpoch,
    };
  }

  async continueSession(accessToken: string): Promise<AuthSession> {
    const tokenHash = await hashSecret(accessToken);
    return this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const now = await databaseNow(transaction);
      const row = await findSessionByHash(transaction, "access", tokenHash, true);
      if (row === null) throw new AuthServiceError("AUTHENTICATION_REQUIRED", 401, false, "Требуется действующая сессия CRM.");
      assertSessionUsable(row, now, "crm_session", this.options.providerNamespace);
      const warningAt = Math.min(row.idleExpiresAt.getTime(), row.lastInteractiveAt.getTime() + idleWindowMs) - warningWindowMs;
      if (now.getTime() < warningAt) throw new AuthServiceError("SESSION_CONTINUE_NOT_AVAILABLE", 409, false, "Продление доступно только в окне предупреждения.");
      const nextIdle = new Date(Math.min(now.getTime() + idleWindowMs, row.absoluteExpiresAt.getTime()));
      const updated = await transaction.execute<Pick<SessionRow, "lastInteractiveAt" | "idleExpiresAt" | "revision">>(sql`
        UPDATE crm.crm_sessions
        SET last_interactive_at = clock_timestamp(), idle_expires_at = ${nextIdle}::timestamptz,
            updated_at = clock_timestamp(), revision = revision + 1
        WHERE id = ${row.id}::uuid AND status = 'active'
        RETURNING last_interactive_at AS "lastInteractiveAt", idle_expires_at AS "idleExpiresAt", revision
      `);
      const values = updated.rows[0];
      if (values === undefined) throw new AuthServiceError("SESSION_EXPIRED", 401, false, "Сессия завершена. Войдите снова.");
      return toAuthSession({ ...row, ...values }, now);
    }));
  }

  async revokeSession(accessToken: string, reason = "user_logout"): Promise<void> {
    const tokenHash = await hashSecret(accessToken);
    const revoke = () => this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const row = await findSessionByHash(transaction, "access", tokenHash, true);
      if (row === null) return;
      await transaction.execute(sql`
        UPDATE crm.crm_sessions
        SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = ${reason}::text,
            updated_at = clock_timestamp(), revision = revision + 1
        WHERE id = ${row.id}::uuid AND status = 'active'
      `);
      await insertAudit(transaction, { actorEmployeeId: row.employeeId, action: "auth.logout", entityType: "crmSession", entityId: row.id, reason });
    }));
    try {
      await revoke();
    } catch (error) {
      this.options.defer(this.retryDatabaseEffect(revoke));
      throw error;
    }
  }

  async revokeSessionByRefreshToken(refreshToken: string, reason = "user_logout"): Promise<void> {
    const tokenHash = await hashSecret(refreshToken);
    const revoke = () => this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const row = await findSessionByHash(transaction, "refresh", tokenHash, true);
      if (row === null) {
        const replay = await transaction.execute<{ familyId: string }>(sql`
          SELECT family_id AS "familyId"
          FROM crm.crm_refresh_token_replays
          WHERE refresh_token_hash = ${tokenHash}::text
            AND expires_at > clock_timestamp()
          LIMIT 1
        `);
        const family = replay.rows[0];
        if (family === undefined) return;
        await transaction.execute(sql`
          UPDATE crm.crm_sessions
          SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = ${reason}::text,
              updated_at = clock_timestamp(), revision = revision + 1
          WHERE family_id = ${family.familyId}::uuid AND status = 'active'
        `);
        return;
      }
      await transaction.execute(sql`
        UPDATE crm.crm_sessions
        SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = ${reason}::text,
            updated_at = clock_timestamp(), revision = revision + 1
        WHERE id = ${row.id}::uuid AND status = 'active'
      `);
      await insertAudit(transaction, { actorEmployeeId: row.employeeId, action: "auth.logout", entityType: "crmSession", entityId: row.id, reason });
    }));
    try {
      await revoke();
    } catch (error) {
      this.options.defer(this.retryDatabaseEffect(revoke));
      throw error;
    }
  }

  /**
   * The current password is verified with the provider before its admin update.
   * Any ambiguous provider outcome leaves the CRM identity fail-closed until an
   * operator reconciles it; we never roll credentials back after dispatch.
   */
  async changePassword(accessToken: string, input: { currentPassword: string; newPassword: string }): Promise<void> {
    const authenticated = await this.authenticate(accessToken, "password_change");
    const operationId = createUuidV7();
    const login = await this.options.withDatabase(async (database) => {
      const result = await database.execute<{ recoveryEmail: string; providerSubjectId: string }>(sql`
        SELECT employee.recovery_email AS "recoveryEmail", binding.provider_subject_id AS "providerSubjectId"
        FROM crm.login_claims AS claim
        JOIN crm.employees AS employee ON employee.id = claim.employee_id
        JOIN crm.auth_bindings AS binding ON binding.employment_epoch_id = claim.employment_epoch_id
        WHERE claim.employment_epoch_id = ${authenticated.employmentEpochId}::uuid
          AND claim.state = 'active'
          AND binding.state = 'active'
        LIMIT 1
      `);
      const row = result.rows[0];
      if (row === undefined) throw new AuthServiceError("IDENTITY_RECONCILIATION_REQUIRED", 409, false, "Учётная запись требует проверки безопасности.");
      return row;
    });
    const verification = await this.options.provider.signInWithPassword({ login: login.recoveryEmail, password: input.currentPassword });
    if (verification.kind === "unavailable") throw new AuthServiceError("AUTH_PROVIDER_UNAVAILABLE", 503, true, "Служба входа временно недоступна. Повторите попытку.");
    if (verification.kind === "invalid_credentials" || verification.session.subjectId !== login.providerSubjectId || !verification.session.authenticationMethods.includes("password")) {
      throw genericSignInError();
    }

    const claimed = await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const result = await transaction.execute<{ employeeId: string }>(sql`
        UPDATE crm.employee_security_states
        SET credential_state = 'changing', credential_operation_id = ${operationId}::uuid,
            updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${authenticated.employeeId}::uuid
          AND employment_epoch_id = ${authenticated.employmentEpochId}::uuid
          AND credential_state IN ('temporary_password', 'password_change_required', 'ready')
          AND session_epoch = ${authenticated.sessionEpoch}::integer
          AND credential_epoch = ${authenticated.credentialEpoch}::integer
        RETURNING employee_id AS "employeeId"
      `);
      return result.rows[0] !== undefined;
    }));
    await this.ensureProviderSessionRevoked(verification.session.accessToken, verification.session.sessionId);
    if (!claimed) throw new AuthServiceError("PASSWORD_CHANGE_IN_PROGRESS", 409, false, "Смена пароля уже выполняется. Дождитесь завершения или начните восстановление.");
    const updated = await this.options.provider.updatePassword({ subjectId: login.providerSubjectId, password: input.newPassword });
    if (updated !== "updated") {
      await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
        await transaction.execute(sql`
          UPDATE crm.employee_security_states
          SET credential_state = 'reconciliation_required', credential_operation_id = NULL, session_epoch = session_epoch + 1,
              updated_at = clock_timestamp(), version = version + 1
          WHERE employee_id = ${authenticated.employeeId}::uuid
            AND credential_state = 'changing'
            AND credential_operation_id = ${operationId}::uuid
        `);
        await transaction.execute(sql`
          UPDATE crm.crm_sessions
          SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = 'password_change_ambiguous',
              updated_at = clock_timestamp(), revision = revision + 1
          WHERE employee_id = ${authenticated.employeeId}::uuid AND status = 'active'
        `);
        await insertAudit(transaction, { actorEmployeeId: authenticated.employeeId, action: "auth.password.change_reconciliation_required", entityType: "employee", entityId: authenticated.employeeId, reason: "provider_update_ambiguous" });
      }));
      throw new AuthServiceError("AUTH_PROVIDER_UNAVAILABLE", 503, true, "Пароль требует проверки безопасности. Обратитесь к руководителю.");
    }
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const finalized = await transaction.execute<{ employeeId: string }>(sql`
        UPDATE crm.employee_security_states
        SET credential_state = 'ready', credential_operation_id = NULL, temporary_password_expires_at = NULL, credential_epoch = credential_epoch + 1, session_epoch = session_epoch + 1,
            login_failure_count = 0, login_failure_window_started_at = NULL, login_locked_until = NULL, updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${authenticated.employeeId}::uuid
          AND employment_epoch_id = ${authenticated.employmentEpochId}::uuid
          AND credential_state = 'changing'
          AND credential_operation_id = ${operationId}::uuid
        RETURNING employee_id AS "employeeId"
      `);
      if (finalized.rows[0] === undefined) throw new AuthServiceError("IDENTITY_RECONCILIATION_REQUIRED", 409, false, "Учётная запись требует проверки безопасности.");
      await transaction.execute(sql`
        UPDATE crm.auth_recovery_challenges
        SET state = 'expired', recovery_grant_hash = NULL
        WHERE employee_id = ${authenticated.employeeId}::uuid
          AND state IN ('pending', 'verified')
      `);
      await transaction.execute(sql`
        UPDATE crm.crm_sessions
        SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = 'password_changed',
            updated_at = clock_timestamp(), revision = revision + 1
        WHERE employee_id = ${authenticated.employeeId}::uuid AND status = 'active'
      `);
      await insertAudit(transaction, { actorEmployeeId: authenticated.employeeId, action: "auth.password.changed", entityType: "employee", entityId: authenticated.employeeId, reason: "current_password_verified" });
    }));
  }

  /** Enumeration-safe request; only a known active identity reaches the provider. */
  async requestPasswordRecovery(login: string): Promise<void> {
    const startedAt = Date.now();
    const canonicalLogin = canonicalizeUsername(login);
    if (canonicalLogin === null) {
      await waitForEnumerationFloor(startedAt);
      return;
    }
    const identity = await this.options.withDatabase(async (database) => {
      const now = await databaseNow(database);
      return findIdentityForLogin(database, canonicalLogin).then((row) => row !== null && isActiveIdentity(row, now) ? row : null);
    });
    if (identity === null) {
      await waitForEnumerationFloor(startedAt);
      return;
    }
    const challengeId = createUuidV7();
    const stateVerifier = createOpaqueToken();
    const codeVerifier = createOpaqueToken(48);
    const [stateVerifierHash, codeVerifierCiphertext, codeChallenge] = await Promise.all([
      hashSecret(stateVerifier),
      this.options.tokenCipher.encrypt(codeVerifier),
      createPkceChallenge(codeVerifier),
    ]);
    const redirectTo = new URL(this.options.recoveryCallbackUrl);
    redirectTo.searchParams.set("challenge", challengeId);
    redirectTo.searchParams.set("state", stateVerifier);
    const reserved = await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const current = await transaction.execute<{ accessState: string; credentialState: string; employmentEpochId: string | null }>(sql`
        SELECT access_state AS "accessState", credential_state AS "credentialState",
               employment_epoch_id AS "employmentEpochId"
        FROM crm.employee_security_states
        WHERE employee_id = ${identity.employeeId}::uuid
        FOR UPDATE
      `);
      const security = current.rows[0];
      if (
        security === undefined
        || security.accessState !== "active"
        || !["ready", "temporary_password", "password_change_required"].includes(security.credentialState)
        || security.employmentEpochId !== identity.employmentEpochId
      ) return false;
      const recent = await transaction.execute<{ recent: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1
          FROM crm.auth_recovery_challenges
          WHERE employee_id = ${identity.employeeId}::uuid
            AND created_at > clock_timestamp() - interval '1 minute'
        ) AS recent
      `);
      if (recent.rows[0]?.recent === true) return false;
      await transaction.execute(sql`
        UPDATE crm.auth_recovery_challenges
        SET state = 'expired', recovery_grant_hash = NULL
        WHERE employee_id = ${identity.employeeId}::uuid
          AND state IN ('pending', 'verified')
      `);
      await transaction.execute(sql`
        INSERT INTO crm.auth_recovery_challenges (
          id, employee_id, employment_epoch_id, auth_binding_id,
          credential_epoch_at_issue, state_verifier_hash, code_verifier_ciphertext, expires_at
        ) VALUES (
          ${challengeId}::uuid, ${identity.employeeId}::uuid, ${identity.employmentEpochId}::uuid,
          ${identity.bindingId}::uuid, ${identity.credentialEpoch}::integer, ${stateVerifierHash}::text,
          ${codeVerifierCiphertext}::text, clock_timestamp() + interval '30 minutes'
        )
      `);
      return true;
    }));
    if (!reserved) {
      await waitForEnumerationFloor(startedAt);
      return;
    }
    this.options.defer((async () => {
      const outcome = await this.options.provider.sendPasswordRecovery({ login: identity.recoveryEmail, redirectTo: redirectTo.toString(), codeChallenge });
      if (outcome === "unavailable") {
        await this.expireRecoveryChallenge(challengeId, "provider_unavailable");
        return;
      }
      await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
        await insertAudit(transaction, { actorEmployeeId: identity.employeeId, action: "auth.password.recovery_requested", entityType: "employee", entityId: identity.employeeId, reason: "bff_recovery_request" });
      }));
    })());
    await waitForEnumerationFloor(startedAt);
  }

  /** Exchanges the provider's PKCE code server-side and issues an opaque one-time recovery grant. */
  async completePasswordRecovery(input: { challengeId: string; stateVerifier: string; code: string }): Promise<{ recoveryGrant: string; redirectTo: string }> {
    if (!isUuid(input.challengeId) || input.stateVerifier.length < 32 || input.code.length < 8) {
      throw new AuthServiceError("RECOVERY_LINK_INVALID", 401, false, "Ссылка для восстановления недействительна или устарела.");
    }
    const initial = await this.options.withDatabase(async (database) => {
      const now = await databaseNow(database);
      const challenge = await findRecoveryChallenge(database, input.challengeId);
      if (
        challenge === null
        || challenge.state !== "pending"
        || challenge.expiresAt.getTime() <= now.getTime()
        || !secretsEqual(challenge.stateVerifierHash, await hashSecret(input.stateVerifier))
        || challenge.providerNamespace !== this.options.providerNamespace
        || challenge.accessState !== "active"
        || challenge.credentialEpochAtIssue === null
        || challenge.credentialEpochAtIssue !== challenge.currentCredentialEpoch
        || !["ready", "temporary_password", "password_change_required"].includes(challenge.credentialState)
        || challenge.employmentState !== "active"
        || challenge.bindingState !== "active"
      ) throw new AuthServiceError("RECOVERY_LINK_INVALID", 401, false, "Ссылка для восстановления недействительна или устарела.");
      return challenge;
    });
    let codeVerifier: string;
    try {
      codeVerifier = await this.options.tokenCipher.decrypt(initial.codeVerifierCiphertext);
    } catch {
      await this.expireRecoveryChallenge(initial.id, "recovery_verifier_unreadable");
      throw new AuthServiceError("RECOVERY_LINK_INVALID", 401, false, "Ссылка для восстановления недействительна или устарела.");
    }
    const providerResult = await this.options.provider.exchangeRecoveryCode({ code: input.code, codeVerifier });
    if (providerResult.kind === "unavailable") throw new AuthServiceError("AUTH_PROVIDER_UNAVAILABLE", 503, true, "Служба восстановления временно недоступна. Повторите попытку.");
    if (
      providerResult.kind === "invalid_credentials"
      || providerResult.session.subjectId !== initial.providerSubjectId
      || !providerResult.session.authenticationMethods.includes("recovery")
    ) {
      await this.expireRecoveryChallenge(initial.id, "provider_recovery_identity_mismatch");
      throw new AuthServiceError("RECOVERY_LINK_INVALID", 401, false, "Ссылка для восстановления недействительна или устарела.");
    }
    const recoveryGrant = createOpaqueToken();
    const recoveryGrantHash = await hashSecret(recoveryGrant);
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const now = await databaseNow(transaction);
      const challenge = await findRecoveryChallenge(transaction, input.challengeId, true);
      if (
        challenge === null
        || challenge.state !== "pending"
        || challenge.expiresAt.getTime() <= now.getTime()
        || !secretsEqual(challenge.stateVerifierHash, await hashSecret(input.stateVerifier))
        || challenge.providerSubjectId !== providerResult.session.subjectId
        || challenge.credentialEpochAtIssue === null
        || challenge.credentialEpochAtIssue !== challenge.currentCredentialEpoch
        || !["ready", "temporary_password", "password_change_required"].includes(challenge.credentialState)
      ) throw new AuthServiceError("RECOVERY_LINK_INVALID", 401, false, "Ссылка для восстановления недействительна или устарела.");
      await transaction.execute(sql`
        UPDATE crm.auth_recovery_challenges
        SET state = 'verified', recovery_grant_hash = ${recoveryGrantHash}::text,
            verified_at = clock_timestamp(), grant_expires_at = clock_timestamp() + interval '15 minutes'
        WHERE id = ${challenge.id}::uuid AND state = 'pending'
      `);
      await insertAudit(transaction, { actorEmployeeId: challenge.employeeId, action: "auth.password.recovery_verified", entityType: "employee", entityId: challenge.employeeId, reason: "pkce_recovery_verified" });
    }));
    return { recoveryGrant, redirectTo: this.options.recoveryCompleteUrl };
  }

  async resetPasswordWithRecoveryGrant(recoveryGrant: string, newPassword: string): Promise<void> {
    const recoveryGrantHash = await hashSecret(recoveryGrant);
    const operationId = createUuidV7();
    const challenge = await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const now = await databaseNow(transaction);
      const owner = await transaction.execute<{ employeeId: string }>(sql`
        SELECT employee_id AS "employeeId"
        FROM crm.auth_recovery_challenges
        WHERE recovery_grant_hash = ${recoveryGrantHash}::text
        LIMIT 1
      `);
      const employeeId = owner.rows[0]?.employeeId;
      if (employeeId === undefined) throw new AuthServiceError("RECOVERY_GRANT_INVALID", 401, false, "Восстановление необходимо начать заново.");
      await transaction.execute(sql`
        SELECT employee_id
        FROM crm.employee_security_states
        WHERE employee_id = ${employeeId}::uuid
        FOR UPDATE
      `);
      const result = await transaction.execute<RecoveryChallengeRow>(sql`
        SELECT
          challenge.id,
          challenge.employee_id AS "employeeId",
          challenge.employment_epoch_id AS "employmentEpochId",
          challenge.auth_binding_id AS "authBindingId",
          challenge.credential_epoch_at_issue AS "credentialEpochAtIssue",
          challenge.state_verifier_hash AS "stateVerifierHash",
          challenge.code_verifier_ciphertext AS "codeVerifierCiphertext",
          challenge.recovery_grant_hash AS "recoveryGrantHash",
          challenge.state,
          challenge.expires_at AS "expiresAt",
          challenge.grant_expires_at AS "grantExpiresAt",
          binding.provider_subject_id AS "providerSubjectId",
          binding.provider_namespace AS "providerNamespace",
          security.access_state AS "accessState",
          security.credential_state AS "credentialState",
          security.credential_epoch AS "currentCredentialEpoch",
          epoch.state AS "employmentState",
          binding.state AS "bindingState"
        FROM crm.auth_recovery_challenges AS challenge
        JOIN crm.employee_security_states AS security ON security.employee_id = challenge.employee_id
        JOIN crm.employment_epochs AS epoch ON epoch.id = challenge.employment_epoch_id
        JOIN crm.auth_bindings AS binding ON binding.id = challenge.auth_binding_id
        WHERE challenge.recovery_grant_hash = ${recoveryGrantHash}::text
        LIMIT 1
        FOR UPDATE OF challenge, security, epoch, binding
      `);
      const row = result.rows[0];
      if (
        row === undefined
        || row.state !== "verified"
        || row.recoveryGrantHash === null
        || !secretsEqual(row.recoveryGrantHash, recoveryGrantHash)
        || row.expiresAt.getTime() <= now.getTime()
        || row.grantExpiresAt === null
        || row.grantExpiresAt.getTime() <= now.getTime()
        || row.providerNamespace !== this.options.providerNamespace
        || row.accessState !== "active"
        || row.credentialEpochAtIssue === null
        || row.credentialEpochAtIssue !== row.currentCredentialEpoch
        || !["ready", "temporary_password", "password_change_required"].includes(row.credentialState)
        || row.employmentState !== "active"
        || row.bindingState !== "active"
      ) throw new AuthServiceError("RECOVERY_GRANT_INVALID", 401, false, "Восстановление необходимо начать заново.");
      const credentialClaim = await transaction.execute<{ employeeId: string }>(sql`
        UPDATE crm.employee_security_states
        SET credential_state = 'changing', credential_operation_id = ${operationId}::uuid,
            session_epoch = session_epoch + 1, updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${row.employeeId}::uuid
          AND employment_epoch_id = ${row.employmentEpochId}::uuid
          AND credential_state IN ('ready', 'temporary_password', 'password_change_required')
          AND credential_epoch = ${row.credentialEpochAtIssue}::integer
        RETURNING employee_id AS "employeeId"
      `);
      if (credentialClaim.rows[0] === undefined) {
        throw new AuthServiceError("PASSWORD_CHANGE_IN_PROGRESS", 409, false, "Смена пароля уже выполняется.");
      }
      const claimed = await transaction.execute<{ id: string }>(sql`
        UPDATE crm.auth_recovery_challenges
        SET state = 'consuming', recovery_grant_hash = NULL
        WHERE id = ${row.id}::uuid
          AND state = 'verified'
          AND recovery_grant_hash = ${recoveryGrantHash}::text
        RETURNING id
      `);
      if (claimed.rows[0] === undefined) {
        throw new AuthServiceError("RECOVERY_GRANT_INVALID", 401, false, "Восстановление необходимо начать заново.");
      }
      await transaction.execute(sql`
        UPDATE crm.crm_sessions
        SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = 'recovery_password_change_pending',
            updated_at = clock_timestamp(), revision = revision + 1
        WHERE employee_id = ${row.employeeId}::uuid AND status = 'active'
      `);
      return row;
    }));
    const providerUpdated = await this.options.provider.updatePassword({ subjectId: challenge.providerSubjectId, password: newPassword });
    if (providerUpdated !== "updated") {
      await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
        await transaction.execute(sql`
          UPDATE crm.employee_security_states
          SET credential_state = 'reconciliation_required', credential_operation_id = NULL,
              updated_at = clock_timestamp(), version = version + 1
          WHERE employee_id = ${challenge.employeeId}::uuid
            AND credential_state = 'changing'
            AND credential_operation_id = ${operationId}::uuid
        `);
        await transaction.execute(sql`
          UPDATE crm.auth_recovery_challenges
          SET state = 'quarantined', recovery_grant_hash = NULL
          WHERE id = ${challenge.id}::uuid AND state = 'consuming'
        `);
        await insertAudit(transaction, { actorEmployeeId: challenge.employeeId, action: "auth.password.recovery_reconciliation_required", entityType: "employee", entityId: challenge.employeeId, reason: "provider_update_ambiguous" });
      }));
      throw new AuthServiceError("AUTH_PROVIDER_UNAVAILABLE", 503, true, "Пароль требует проверки безопасности. Обратитесь к руководителю.");
    }
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const finalized = await transaction.execute<{ employeeId: string }>(sql`
        UPDATE crm.employee_security_states
        SET credential_state = 'ready', credential_operation_id = NULL, temporary_password_expires_at = NULL, credential_epoch = credential_epoch + 1, session_epoch = session_epoch + 1,
            login_failure_count = 0, login_failure_window_started_at = NULL, login_locked_until = NULL, updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${challenge.employeeId}::uuid AND employment_epoch_id = ${challenge.employmentEpochId}::uuid
          AND credential_state = 'changing'
          AND credential_operation_id = ${operationId}::uuid
        RETURNING employee_id AS "employeeId"
      `);
      if (finalized.rows[0] === undefined) throw new AuthServiceError("IDENTITY_RECONCILIATION_REQUIRED", 409, false, "Учётная запись требует проверки безопасности.");
      await transaction.execute(sql`
        UPDATE crm.auth_recovery_challenges
        SET state = 'expired', recovery_grant_hash = NULL
        WHERE employee_id = ${challenge.employeeId}::uuid
          AND id <> ${challenge.id}::uuid
          AND state IN ('pending', 'verified')
      `);
      const consumed = await transaction.execute<{ id: string }>(sql`
        UPDATE crm.auth_recovery_challenges
        SET state = 'consumed', recovery_grant_hash = NULL, consumed_at = clock_timestamp()
        WHERE id = ${challenge.id}::uuid AND state = 'consuming'
        RETURNING id
      `);
      if (consumed.rows[0] === undefined) throw new AuthServiceError("IDENTITY_RECONCILIATION_REQUIRED", 409, false, "Учётная запись требует проверки безопасности.");
      await insertAudit(transaction, { actorEmployeeId: challenge.employeeId, action: "auth.password.recovered", entityType: "employee", entityId: challenge.employeeId, reason: "recovery_grant_consumed" });
    }));
  }

  async refreshSession(refreshToken: string): Promise<IssuedSession> {
    const refreshTokenHash = await hashSecret(refreshToken);
    const initial = await this.options.withDatabase(async (database) => {
      const now = await databaseNow(database);
      const row = await findSessionByHash(database, "refresh", refreshTokenHash);
      if (row === null) {
        const replay = await database.execute<RefreshReplayRow>(sql`
          SELECT session_id AS "sessionId", family_id AS "familyId",
                 successor_ciphertext AS "successorCiphertext", consumed_at AS "consumedAt"
          FROM crm.crm_refresh_token_replays
          WHERE refresh_token_hash = ${refreshTokenHash}::text
            AND expires_at > clock_timestamp()
          LIMIT 1
        `);
        const family = replay.rows[0];
        if (family !== undefined && now.getTime() - family.consumedAt.getTime() <= refreshReplayGraceMs) {
          return { kind: "successor" as const, replay: family };
        }
        if (family !== undefined) await database.transaction(async (transaction) => {
          await transaction.execute(sql`
            UPDATE crm.crm_sessions
            SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = 'refresh_token_replay',
                updated_at = clock_timestamp(), revision = revision + 1
            WHERE family_id = ${family.familyId}::uuid AND status = 'active'
          `);
        });
        throw new AuthServiceError("AUTHENTICATION_REQUIRED", 401, false, "Сессия завершена. Войдите снова.");
      }
      assertSessionUsable(row, now, row.credentialState === "ready" ? "crm_session" : "password_change", this.options.providerNamespace);
      return { kind: "current" as const, row };
    });
    if (initial.kind === "successor") return this.restoreRefreshSuccessor(initial.replay);
    const current = initial.row;
    let providerRefreshToken: string;
    try {
      providerRefreshToken = await this.options.tokenCipher.decrypt(current.providerRefreshTokenCiphertext);
    } catch {
      await this.revokeById(current.id, "provider_token_unreadable");
      throw new AuthServiceError("SESSION_EXPIRED", 401, false, "Сессия завершена. Войдите снова.");
    }
    const providerResult = await this.options.provider.refreshSession(providerRefreshToken);
    if (providerResult.kind === "unavailable") throw new AuthServiceError("AUTH_PROVIDER_UNAVAILABLE", 503, true, "Служба входа временно недоступна. Повторите попытку.");
    if (providerResult.kind === "invalid_credentials") {
      const successor = await this.findRecentRefreshSuccessor(refreshTokenHash);
      if (successor !== null) return this.restoreRefreshSuccessor(successor);
      await this.revokeById(current.id, "provider_session_invalid");
      throw new AuthServiceError("SESSION_EXPIRED", 401, false, "Сессия завершена. Войдите снова.");
    }
    if (providerResult.session.subjectId !== current.providerSubjectId || !providerResult.session.authenticationMethods.includes("password")) {
      await this.revokeById(current.id, "provider_session_invalid");
      throw new AuthServiceError("SESSION_EXPIRED", 401, false, "Сессия завершена. Войдите снова.");
    }
    return this.rotateLocalSession(current.id, refreshTokenHash, providerResult.session);
  }

  private async reconcileProviderSession(accessTokenHash: string, route: "crm_session" | "password_change"): Promise<{ session: SessionRow; now: Date }> {
    const initial = await this.options.withDatabase(async (database) => {
      const now = await databaseNow(database);
      const row = await findSessionByHash(database, "access", accessTokenHash);
      if (row === null) throw new AuthServiceError("AUTHENTICATION_REQUIRED", 401, false, "Требуется действующая сессия CRM.");
      assertSessionUsable(row, now, route, this.options.providerNamespace);
      return { row, now };
    });
    let providerRefreshToken: string;
    try {
      providerRefreshToken = await this.options.tokenCipher.decrypt(initial.row.providerRefreshTokenCiphertext);
    } catch {
      await this.revokeById(initial.row.id, "provider_token_unreadable");
      throw new AuthServiceError("SESSION_EXPIRED", 401, false, "Сессия завершена. Войдите снова.");
    }
    const providerResult = await this.options.provider.refreshSession(providerRefreshToken);
    if (providerResult.kind === "unavailable") {
      // A previously reconciled session stays usable only until the 30-minute deadline.
      if (initial.row.providerReconciledAt !== null && initial.now.getTime() - initial.row.providerReconciledAt.getTime() < providerReconciliationWindowMs) return { session: initial.row, now: initial.now };
      throw new AuthServiceError("AUTH_PROVIDER_UNAVAILABLE", 503, true, "Не удалось подтвердить активность сессии у провайдера.");
    }
    if (providerResult.kind === "invalid_credentials" || providerResult.session.subjectId !== initial.row.providerSubjectId || !providerResult.session.authenticationMethods.includes("password")) {
      await this.revokeById(initial.row.id, "provider_session_invalid");
      throw new AuthServiceError("SESSION_EXPIRED", 401, false, "Сессия завершена. Войдите снова.");
    }
    const cipher = await this.options.tokenCipher.encrypt(providerResult.session.refreshToken);
    return this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const now = await databaseNow(transaction);
      const row = await findSessionByHash(transaction, "access", accessTokenHash, true);
      if (row === null) throw new AuthServiceError("SESSION_EXPIRED", 401, false, "Сессия завершена. Войдите снова.");
      assertSessionUsable(row, now, route, this.options.providerNamespace);
      await transaction.execute(sql`
        UPDATE crm.crm_sessions
        SET provider_session_id = ${providerResult.session.sessionId}::uuid,
            provider_refresh_token_ciphertext = ${cipher}::text,
            provider_reconciled_at = clock_timestamp(), updated_at = clock_timestamp(), revision = revision + 1
        WHERE id = ${row.id}::uuid AND revision = ${row.revision}::integer
      `);
      const refreshed = await findSessionByHash(transaction, "access", accessTokenHash, true);
      if (refreshed === null) throw new AuthServiceError("SESSION_EXPIRED", 401, false, "Сессия завершена. Войдите снова.");
      assertSessionUsable(refreshed, now, route, this.options.providerNamespace);
      return { session: refreshed, now };
    }));
  }

  private async rotateLocalSession(sessionId: string, refreshTokenHash: string, providerSession: ProviderSession): Promise<IssuedSession> {
    const accessToken = createOpaqueToken();
    const refreshToken = createOpaqueToken();
    const accessTokenHash = await hashSecret(accessToken);
    const nextRefreshHash = await hashSecret(refreshToken);
    const cipher = await this.options.tokenCipher.encrypt(providerSession.refreshToken);
    const successorCiphertext = await this.options.tokenCipher.encrypt(JSON.stringify({ accessToken, refreshToken }));
    const rotation = await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const now = await databaseNow(transaction);
      const row = await findSessionByHash(transaction, "refresh", refreshTokenHash, true);
      if (row === null || row.id !== sessionId) {
        const replay = await transaction.execute<RefreshReplayRow>(sql`
          SELECT session_id AS "sessionId", family_id AS "familyId",
                 successor_ciphertext AS "successorCiphertext", consumed_at AS "consumedAt"
          FROM crm.crm_refresh_token_replays
          WHERE refresh_token_hash = ${refreshTokenHash}::text
            AND expires_at > clock_timestamp()
          LIMIT 1
        `);
        const family = replay.rows[0];
        if (family !== undefined && now.getTime() - family.consumedAt.getTime() <= refreshReplayGraceMs) {
          return { kind: "successor" as const, replay: family };
        }
        if (family !== undefined) await transaction.execute(sql`
          UPDATE crm.crm_sessions
          SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = 'refresh_token_replay',
              updated_at = clock_timestamp(), revision = revision + 1
          WHERE family_id = ${family.familyId}::uuid AND status = 'active'
        `);
        return { kind: "expired" as const };
      }
      assertSessionUsable(row, now, row.credentialState === "ready" ? "crm_session" : "password_change", this.options.providerNamespace);
      await transaction.execute(sql`
        INSERT INTO crm.crm_refresh_token_replays (refresh_token_hash, session_id, family_id, successor_ciphertext, expires_at)
        VALUES (${refreshTokenHash}::text, ${row.id}::uuid, ${row.familyId}::uuid, ${successorCiphertext}::text, ${row.absoluteExpiresAt}::timestamptz)
        ON CONFLICT (refresh_token_hash) DO NOTHING
      `);
      const updated = await transaction.execute<Pick<SessionRow, "revision" | "lastInteractiveAt" | "idleExpiresAt" | "absoluteExpiresAt">>(sql`
        UPDATE crm.crm_sessions
        SET access_token_hash = ${accessTokenHash}::text,
            refresh_token_hash = ${nextRefreshHash}::text,
            provider_session_id = ${providerSession.sessionId}::uuid,
            provider_refresh_token_ciphertext = ${cipher}::text,
            provider_reconciled_at = clock_timestamp(), refresh_generation = refresh_generation + 1,
            updated_at = clock_timestamp(), revision = revision + 1
        WHERE id = ${row.id}::uuid
          AND refresh_token_hash = ${refreshTokenHash}::text
          AND revision = ${row.revision}::integer
        RETURNING revision, last_interactive_at AS "lastInteractiveAt", idle_expires_at AS "idleExpiresAt", absolute_expires_at AS "absoluteExpiresAt"
      `);
      const fields = updated.rows[0];
      if (fields === undefined) throw new AuthServiceError("SESSION_EXPIRED", 401, false, "Сессия завершена. Войдите снова.");
      const completed = { ...row, ...fields, accessTokenHash, refreshTokenHash: nextRefreshHash, providerRefreshTokenCiphertext: cipher, providerSessionId: providerSession.sessionId, providerReconciledAt: now };
      return { kind: "issued" as const, issued: {
        accessToken,
        accessTokenExpiresAt: completed.idleExpiresAt.toISOString(),
        refreshToken,
        session: toAuthSession(completed, now),
      } };
    }));
    if (rotation.kind === "successor") return this.restoreRefreshSuccessor(rotation.replay);
    if (rotation.kind === "expired") {
      throw new AuthServiceError("SESSION_EXPIRED", 401, false, "Сессия завершена. Войдите снова.");
    }
    return rotation.issued;
  }

  private async findRecentRefreshSuccessor(refreshTokenHash: string): Promise<RefreshReplayRow | null> {
    return this.options.withDatabase(async (database) => {
      const result = await database.execute<RefreshReplayRow>(sql`
        SELECT session_id AS "sessionId", family_id AS "familyId",
               successor_ciphertext AS "successorCiphertext", consumed_at AS "consumedAt"
        FROM crm.crm_refresh_token_replays
        WHERE refresh_token_hash = ${refreshTokenHash}::text
          AND consumed_at > clock_timestamp() - interval '10 seconds'
          AND expires_at > clock_timestamp()
        LIMIT 1
      `);
      return result.rows[0] ?? null;
    });
  }

  private async restoreRefreshSuccessor(replay: RefreshReplayRow): Promise<IssuedSession> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.options.tokenCipher.decrypt(replay.successorCiphertext));
    } catch {
      await this.revokeFamily(replay.familyId, "refresh_successor_unreadable");
      throw new AuthServiceError("SESSION_EXPIRED", 401, false, "Сессия завершена. Войдите снова.");
    }
    const accessToken = payloadString(parsed, "accessToken");
    const refreshToken = payloadString(parsed, "refreshToken");
    if (accessToken === null || refreshToken === null) {
      await this.revokeFamily(replay.familyId, "refresh_successor_invalid");
      throw new AuthServiceError("SESSION_EXPIRED", 401, false, "Сессия завершена. Войдите снова.");
    }
    const [accessTokenHash, refreshTokenHash] = await Promise.all([hashSecret(accessToken), hashSecret(refreshToken)]);
    return this.options.withDatabase(async (database) => {
      const now = await databaseNow(database);
      const row = await findSessionByHash(database, "refresh", refreshTokenHash);
      if (row === null || row.id !== replay.sessionId || row.familyId !== replay.familyId || !secretsEqual(row.accessTokenHash, accessTokenHash)) {
        throw new AuthServiceError("SESSION_EXPIRED", 401, false, "Сессия завершена. Войдите снова.");
      }
      assertSessionUsable(row, now, row.credentialState === "ready" ? "crm_session" : "password_change", this.options.providerNamespace);
      return {
        accessToken,
        accessTokenExpiresAt: row.idleExpiresAt.toISOString(),
        refreshToken,
        session: toAuthSession(row, now),
      };
    });
  }

  /** Retries security-sensitive provider effects claimed from the durable DB outbox. */
  async reconcileProviderEffects(): Promise<void> {
    const effects = await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const claimed = await transaction.execute<ProviderEffectRow>(sql`
        WITH candidates AS (
          SELECT id
          FROM crm.security_outbox
          WHERE aggregate_type = 'auth_provider_effect'
            AND operation IN ('auth_provider_session_revoke', 'auth_provider_user_ban')
            AND state IN ('pending', 'processing')
            AND next_attempt_at <= clock_timestamp()
          ORDER BY created_at
          LIMIT 10
          FOR UPDATE SKIP LOCKED
        )
        UPDATE crm.security_outbox AS effect
        SET state = 'processing', attempts = attempts + 1,
            next_attempt_at = clock_timestamp() + interval '5 minutes'
        FROM candidates
        WHERE effect.id = candidates.id
        RETURNING effect.id, effect.operation, effect.payload
      `);
      return claimed.rows;
    }));

    for (const effect of effects) {
      let state: "completed" | "pending" | "quarantined" = "pending";
      try {
        if (effect.operation === "auth_provider_user_ban") {
          const subjectId = payloadString(effect.payload, "subjectId");
          state = subjectId !== null && isUuid(subjectId) && await this.options.provider.banUser(subjectId) === "banned" ? "completed" : "pending";
        } else {
          const ciphertext = payloadString(effect.payload, "accessTokenCiphertext");
          if (ciphertext === null) state = "quarantined";
          else {
            const accessToken = await this.options.tokenCipher.decrypt(ciphertext);
            state = await this.options.provider.revokeSession(accessToken) === "revoked" ? "completed" : "pending";
          }
        }
      } catch {
        state = "quarantined";
      }
      await this.options.withDatabase(async (database) => database.execute(sql`
        UPDATE crm.security_outbox
        SET state = ${state}::text,
            payload = CASE WHEN ${state}::text = 'completed' THEN '{}'::jsonb ELSE payload END,
            completed_at = CASE WHEN ${state}::text = 'completed' THEN clock_timestamp() ELSE NULL END,
            next_attempt_at = CASE WHEN ${state}::text = 'pending' THEN clock_timestamp() + interval '5 minutes' ELSE next_attempt_at END
        WHERE id = ${effect.id}::uuid AND state = 'processing'
      `));
    }
  }

  private async ensureProviderSessionRevoked(accessToken: string, aggregateId: string): Promise<void> {
    const outcome = await this.options.provider.revokeSession(accessToken).catch(() => "unavailable" as const);
    if (outcome === "revoked") return;
    const accessTokenCiphertext = await this.options.tokenCipher.encrypt(accessToken);
    await this.persistProviderEffect("auth_provider_session_revoke", aggregateId, { accessTokenCiphertext });
  }

  private async ensureProviderUserBanned(subjectId: string, aggregateId: string): Promise<void> {
    const outcome = await this.options.provider.banUser(subjectId).catch(() => "unavailable" as const);
    if (outcome === "banned") return;
    await this.persistProviderEffect("auth_provider_user_ban", aggregateId, { subjectId });
  }

  private async persistProviderEffect(operation: ProviderEffectRow["operation"], aggregateId: string, payload: Record<string, string>): Promise<void> {
    await this.options.withDatabase(async (database) => database.execute(sql`
      INSERT INTO crm.security_outbox (id, operation, aggregate_type, aggregate_id, payload)
      VALUES (${createUuidV7()}::uuid, ${operation}::text, 'auth_provider_effect', ${aggregateId}::uuid, ${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (operation, aggregate_type, aggregate_id) DO UPDATE
      SET payload = EXCLUDED.payload,
          state = CASE WHEN crm.security_outbox.state = 'completed' THEN 'completed' ELSE 'pending' END,
          next_attempt_at = CASE WHEN crm.security_outbox.state = 'completed' THEN crm.security_outbox.next_attempt_at ELSE clock_timestamp() END
    `));
  }

  private async retryDatabaseEffect(effect: () => Promise<void>): Promise<void> {
    for (const delayMs of [250, 1_000, 4_000]) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      try {
        await effect();
        return;
      } catch {
        // The next bounded retry remains attached to the Worker lifetime.
      }
    }
  }

  private async recordInvalidPasswordAttempt(attemptId: string, canonicalLogin: string, employeeId: string): Promise<void> {
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const now = await databaseNow(transaction);
      const identity = await findIdentityForLogin(transaction, canonicalLogin, true);
      if (identity === null || identity.employeeId !== employeeId) return;
      const completed = await completeAttempt(transaction, { id: attemptId, employeeId, outcome: "invalid_credentials", providerAttempted: true });
      if (!completed) return;
      if (identity.loginLockedUntil !== null && identity.loginLockedUntil.getTime() > now.getTime()) {
        await transaction.execute(sql`UPDATE crm.auth_login_attempts SET outcome = 'locked' WHERE id = ${attemptId}::uuid AND outcome = 'invalid_credentials'`);
        await insertAudit(transaction, { actorEmployeeId: employeeId, action: "auth.login.locked", entityType: "authLoginAttempt", entityId: attemptId, reason: "concurrent_lock" });
        return;
      }
      const windowStartedAt = identity.loginFailureWindowStartedAt;
      const inCurrentWindow = windowStartedAt !== null && now.getTime() - windowStartedAt.getTime() < 15 * 60 * 1000;
      const count = Math.min(inCurrentWindow ? (identity.loginFailureCount ?? 0) + 1 : 1, 5);
      const locked = count >= 5;
      await transaction.execute(sql`
        UPDATE crm.employee_security_states
        SET login_failure_count = ${count}::integer,
            login_failure_window_started_at = CASE
              WHEN ${inCurrentWindow}::boolean THEN login_failure_window_started_at
              ELSE clock_timestamp()
            END,
            login_locked_until = CASE WHEN ${locked}::boolean THEN clock_timestamp() + interval '15 minutes' ELSE NULL END,
            updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${employeeId}::uuid
      `);
      await insertAudit(transaction, {
        actorEmployeeId: employeeId,
        action: locked ? "auth.login.locked" : "auth.login.failed",
        entityType: "authLoginAttempt",
        entityId: attemptId,
        reason: locked ? "five_invalid_credentials" : "invalid_credentials",
        after: { failureCount: count },
      });
    }));
  }

  private async recordAttempt(attemptId: string, _canonicalLogin: string, employeeId: string | null, outcome: string, providerAttempted: boolean, action: string): Promise<void> {
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const completed = await completeAttempt(transaction, { id: attemptId, employeeId, outcome, providerAttempted });
      if (completed) await insertAudit(transaction, { actorEmployeeId: null, action, entityType: "authLoginAttempt", entityId: attemptId, reason: outcome });
    }));
  }

  private async quarantineIdentity(employeeId: string, attemptId: string, reason: string): Promise<void> {
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE crm.employee_security_states
        SET access_state = 'security_quarantined', session_epoch = session_epoch + 1,
            updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${employeeId}::uuid
      `);
      await transaction.execute(sql`
        UPDATE crm.crm_sessions
        SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = ${reason}::text,
            updated_at = clock_timestamp(), revision = revision + 1
        WHERE employee_id = ${employeeId}::uuid AND status = 'active'
      `);
      await insertAudit(transaction, { actorEmployeeId: employeeId, action: "auth.identity.quarantined", entityType: "authLoginAttempt", entityId: attemptId, reason });
    }));
  }

  private async revokeById(sessionId: string, reason: string): Promise<void> {
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const updated = await transaction.execute<{ employeeId: string }>(sql`
        UPDATE crm.crm_sessions
        SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = ${reason}::text,
            updated_at = clock_timestamp(), revision = revision + 1
        WHERE id = ${sessionId}::uuid AND status = 'active'
        RETURNING employee_id AS "employeeId"
      `);
      const row = updated.rows[0];
      if (row !== undefined) await insertAudit(transaction, { actorEmployeeId: row.employeeId, action: "auth.session.revoked", entityType: "crmSession", entityId: sessionId, reason });
    }));
  }

  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE crm.crm_sessions
        SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = ${reason}::text,
            updated_at = clock_timestamp(), revision = revision + 1
        WHERE family_id = ${familyId}::uuid AND status = 'active'
      `);
    }));
  }

  private async expireRecoveryChallenge(challengeId: string, reason: string): Promise<void> {
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const updated = await transaction.execute<{ employeeId: string }>(sql`
        UPDATE crm.auth_recovery_challenges
        SET state = 'expired', recovery_grant_hash = NULL
        WHERE id = ${challengeId}::uuid AND state IN ('pending', 'verified')
        RETURNING employee_id AS "employeeId"
      `);
      const row = updated.rows[0];
      if (row !== undefined) await insertAudit(transaction, { actorEmployeeId: row.employeeId, action: "auth.password.recovery_expired", entityType: "employee", entityId: row.employeeId, reason });
    }));
  }
}
