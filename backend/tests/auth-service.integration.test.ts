import { Client } from "pg";
import { describe, expect, test } from "vitest";

import { migrate } from "../scripts/migrate";
import { EmployeeService } from "../src/access/employees";
import { hashSecret, type AuthTokenCipher } from "../src/auth/crypto";
import type { AuthProvider, ProviderSession } from "../src/auth/provider";
import { AuthService, AuthServiceError, type IssuedSession } from "../src/auth/service";
import { withRequestDatabase } from "../src/db/client";
import { withEmptyTestDatabase } from "./helpers/database";

const employeeId = "00000000-0000-7000-8000-000000000101";
const epochId = "00000000-0000-7000-8000-000000000102";
const bindingId = "00000000-0000-7000-8000-000000000103";
const subjectId = "00000000-0000-7000-8000-000000000104";
const sessionId = "00000000-0000-7000-8000-000000000105";
const familyId = "00000000-0000-7000-8000-000000000106";
const assignmentId = "00000000-0000-7000-8000-000000000107";
const accessToken = "integration-access-token";
const refreshToken = "integration-refresh-token";

const tokenCipher: AuthTokenCipher = {
  async encrypt(value) { return `encrypted:${value}`; },
  async decrypt(value) {
    if (!value.startsWith("encrypted:")) throw new Error("invalid test ciphertext");
    return value.slice("encrypted:".length);
  },
};

function providerSession(overrides: Partial<ProviderSession> = {}): ProviderSession {
  return {
    subjectId,
    sessionId: crypto.randomUUID(),
    accessToken: `provider-access-${crypto.randomUUID()}`,
    refreshToken: `provider-refresh-${crypto.randomUUID()}`,
    expiresInSeconds: 3_600,
    login: "security.test@example.invalid",
    authenticationMethods: ["password"],
    ...overrides,
  };
}

function provider(overrides: Partial<AuthProvider>): AuthProvider {
  return {
    async signInWithPassword() { return { kind: "success", session: providerSession() }; },
    async refreshSession() { return { kind: "success", session: providerSession() }; },
    async revokeSession() { return "revoked"; },
    async updatePassword() { return "updated"; },
    async restoreUser() { return "restored"; },
    async banUser() { return "banned"; },
    async sendPasswordRecovery() { return "accepted"; },
    async exchangeRecoveryCode() { return { kind: "success", session: providerSession({ authenticationMethods: ["recovery"] }) }; },
    async createUser() { return "created"; },
    async getUserById() { return { subjectId, login: "security.test@example.invalid", marker: "test-marker" }; },
    ...overrides,
  };
}

async function seedIdentity(admin: Client): Promise<void> {
  const [accessTokenHash, refreshTokenHash] = await Promise.all([hashSecret(accessToken), hashSecret(refreshToken)]);
  await admin.query("BEGIN");
  try {
    await admin.query("INSERT INTO crm.employees (id, full_name, email, recovery_email, created_at, updated_at) VALUES ($1, 'Security Test', 'security.test@example.invalid', 'security.test@example.invalid', clock_timestamp(), clock_timestamp())", [employeeId]);
    await admin.query("INSERT INTO crm.employment_epochs (id, employee_id, sequence, state, started_at) VALUES ($1, $2, 1, 'active', clock_timestamp())", [epochId, employeeId]);
    await admin.query("INSERT INTO crm.employee_security_states (employee_id, employment_epoch_id, access_state, credential_state, provider_reconciled_at) VALUES ($1, $2, 'suspended', 'ready', clock_timestamp())", [employeeId, epochId]);
    await admin.query("INSERT INTO crm.auth_bindings (id, employment_epoch_id, provider_namespace, provider_subject_id, provider_marker, state, confirmed_at) VALUES ($1, $2, 'integration', $3, 'test-marker', 'active', clock_timestamp())", [bindingId, epochId, subjectId]);
    await admin.query("INSERT INTO crm.login_claims (id, canonical_login, employee_id, employment_epoch_id, state) VALUES ('00000000-0000-7000-8000-000000000108', 'security.test', $1, $2, 'active')", [employeeId, epochId]);
    await admin.query("INSERT INTO crm.role_assignments (id, employee_id, employment_epoch_id, role_id, assigned_by_employee_id, reason) SELECT $1, $2, $3, id, $2, 'integration security invariant' FROM crm.roles WHERE system_kind = 'leader'", [assignmentId, employeeId, epochId]);
    await admin.query("UPDATE crm.employee_security_states SET access_state = 'active' WHERE employee_id = $1", [employeeId]);
    await admin.query(`INSERT INTO crm.crm_sessions (
        id, employee_id, employment_epoch_id, auth_binding_id, provider_session_id, family_id,
        issued_session_epoch, issued_credential_epoch, access_token_hash, refresh_token_hash,
        provider_refresh_token_ciphertext, last_interactive_at, idle_expires_at, absolute_expires_at,
        provider_reconciled_at
      ) VALUES (
        $1, $2, $3, $4, '00000000-0000-7000-8000-000000000109', $5,
        1, 1, $6, $7, $8, clock_timestamp(), clock_timestamp() + interval '30 minutes',
        clock_timestamp() + interval '12 hours', clock_timestamp()
      )
    `, [sessionId, employeeId, epochId, bindingId, familyId, accessTokenHash, refreshTokenHash, await tokenCipher.encrypt("provider-refresh-seed")]);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

function service(runtimeUrl: string, authProvider: AuthProvider): AuthService {
  return new AuthService({
    withDatabase: (callback) => withRequestDatabase({ connectionString: runtimeUrl }, callback),
    provider: authProvider,
    tokenCipher,
    providerNamespace: "integration",
    recoveryCallbackUrl: "https://api.test/api/v1/auth/recovery/callback",
    recoveryCompleteUrl: "https://app.test/recovery/reset",
    defer: () => undefined,
  });
}

describe("AuthService concurrency security", () => {
  test("resumes first-leader bootstrap only through the CLI and returns the original secret", async () => {
    await withEmptyTestDatabase(async ({ adminUrl, migrationUrl, runtimeUrl }) => {
      await migrate(migrationUrl);
      let createCalls = 0;
      let createdIdentity: { subjectId: string; login: string; marker: string } | null = null;
      const bootstrapProvider = provider({
        async createUser(input) {
          createCalls += 1;
          createdIdentity = { subjectId: input.subjectId, login: input.login, marker: input.marker };
          return createCalls === 1 ? "unavailable" : "conflict";
        },
        async getUserById() { return createdIdentity; },
      });
      const employeeService = new EmployeeService({
        withDatabase: (callback) => withRequestDatabase({ connectionString: runtimeUrl }, callback),
        provider: bootstrapProvider,
        tokenCipher,
        providerNamespace: "integration",
      });
      const input = {
        fullName: "Initial Leader",
        contactEmail: "leader@example.invalid",
        login: "initial.leader",
        reason: "integration bootstrap",
      };
      await expect(employeeService.bootstrapInitialLeader(input)).rejects.toMatchObject({ code: "PROVISIONING_UNAVAILABLE" });
      await employeeService.reconcileProviderEffects();

      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        await expect(admin.query("SELECT security_initialized_at FROM crm.clinic_security_states LIMIT 1")).resolves.toMatchObject({ rows: [] });
        await expect(admin.query("SELECT state FROM crm.security_outbox WHERE operation = 'provider_user_provision'")).resolves.toMatchObject({ rows: [{ state: "pending" }] });
      } finally {
        await admin.end();
      }

      const resumed = await employeeService.bootstrapInitialLeader(input);
      expect(resumed.temporaryPassword).toMatch(/^T-/u);
      expect(createCalls).toBe(2);
    });
  }, 90_000);

  test("rejects stale self-change verification and stale recovery grants after credential epoch changes", async () => {
    await withEmptyTestDatabase(async ({ adminUrl, migrationUrl, runtimeUrl }) => {
      await migrate(migrationUrl);
      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        await seedIdentity(admin);
        let releaseVerification!: () => void;
        let verificationStarted!: () => void;
        const gate = new Promise<void>((resolve) => { releaseVerification = resolve; });
        const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
        let passwordUpdates = 0;
        const authService = service(runtimeUrl, provider({
          async signInWithPassword() {
            verificationStarted();
            await gate;
            return { kind: "success", session: providerSession() };
          },
          async updatePassword() { passwordUpdates += 1; return "updated"; },
        }));
        const staleChange = authService.changePassword(accessToken, { currentPassword: "old-password", newPassword: "stale-new-password" });
        await started;
        await admin.query("UPDATE crm.employee_security_states SET credential_epoch = credential_epoch + 1, session_epoch = session_epoch + 1 WHERE employee_id = $1", [employeeId]);
        await admin.query("UPDATE crm.crm_sessions SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = 'simulated_admin_reset' WHERE id = $1", [sessionId]);
        releaseVerification();
        await expect(staleChange).rejects.toMatchObject({ code: "PASSWORD_CHANGE_IN_PROGRESS" });
        expect(passwordUpdates).toBe(0);

        const staleGrant = "stale-recovery-grant";
        await admin.query(`INSERT INTO crm.auth_recovery_challenges (
          id, employee_id, employment_epoch_id, auth_binding_id, credential_epoch_at_issue,
          state_verifier_hash, code_verifier_ciphertext, recovery_grant_hash, state,
          expires_at, verified_at, grant_expires_at
        ) VALUES ('00000000-0000-7000-8000-000000000114', $1, $2, $3, 1,
          'state-hash', 'ciphertext', $4, 'verified', clock_timestamp() + interval '30 minutes',
          clock_timestamp(), clock_timestamp() + interval '15 minutes')`, [employeeId, epochId, bindingId, await hashSecret(staleGrant)]);
        await expect(authService.resetPasswordWithRecoveryGrant(staleGrant, "recovery-new-password")).rejects.toMatchObject({ code: "RECOVERY_GRANT_INVALID" });
        expect(passwordUpdates).toBe(0);
      } finally {
        await admin.end();
      }
    });
  }, 90_000);

  test("linearizes refresh/password transitions and never provider-bans a concurrent local lock", async () => {
    await withEmptyTestDatabase(async ({ adminUrl, migrationUrl, runtimeUrl }) => {
      await migrate(migrationUrl);
      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        await seedIdentity(admin);

        let oracleProviderCalls = 0;
        const oracleService = service(runtimeUrl, provider({
          async signInWithPassword() {
            oracleProviderCalls += 1;
            return { kind: "success", session: providerSession() };
          },
        }));
        const reusedAttemptId = "00000000-0000-7000-8000-000000000111";
        await expect(oracleService.signIn({ login: "unknown-login", password: "wrong", attemptId: reusedAttemptId })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
        await expect(oracleService.signIn({ login: "security.test", password: "correct", attemptId: reusedAttemptId })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
        expect(oracleProviderCalls).toBe(0);

        let refreshCalls = 0;
        let releaseRefresh!: () => void;
        let bothRefreshesStarted!: () => void;
        const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
        const refreshStarted = new Promise<void>((resolve) => { bothRefreshesStarted = resolve; });
        const revokedProviderTokens: string[] = [];
        const refreshService = service(runtimeUrl, provider({
          async refreshSession() {
            refreshCalls += 1;
            if (refreshCalls === 2) bothRefreshesStarted();
            await refreshGate;
            return { kind: "success", session: providerSession({ sessionId: "00000000-0000-7000-8000-000000000109" }) };
          },
          async revokeSession(token) { revokedProviderTokens.push(token); return "revoked"; },
        }));
        const concurrentRefreshes = [refreshService.refreshSession(refreshToken), refreshService.refreshSession(refreshToken)];
        await refreshStarted;
        releaseRefresh();
        const refreshResults = await Promise.allSettled(concurrentRefreshes);
        const issued = refreshResults.filter((result): result is PromiseFulfilledResult<IssuedSession> => result.status === "fulfilled").map((result) => result.value);
        expect(issued).toHaveLength(2);
        expect(issued[0]?.accessToken).toBe(issued[1]?.accessToken);
        expect(issued[0]?.refreshToken).toBe(issued[1]?.refreshToken);
        expect(revokedProviderTokens).toHaveLength(0);
        await expect(admin.query("SELECT count(*) FROM crm.crm_sessions WHERE family_id = $1 AND status = 'active'", [familyId])).resolves.toMatchObject({ rows: [{ count: "1" }] });

        let passwordUpdates = 0;
        let passwordVerifications = 0;
        let releasePasswordVerification!: () => void;
        let bothPasswordsVerified!: () => void;
        const passwordGate = new Promise<void>((resolve) => { releasePasswordVerification = resolve; });
        const passwordsVerified = new Promise<void>((resolve) => { bothPasswordsVerified = resolve; });
        let releasePasswordUpdate!: () => void;
        let passwordUpdateStarted!: () => void;
        const passwordUpdateGate = new Promise<void>((resolve) => { releasePasswordUpdate = resolve; });
        const updateStarted = new Promise<void>((resolve) => { passwordUpdateStarted = resolve; });
        const passwordService = service(runtimeUrl, provider({
          async signInWithPassword() {
            passwordVerifications += 1;
            if (passwordVerifications === 2) bothPasswordsVerified();
            await passwordGate;
            return { kind: "success", session: providerSession() };
          },
          async updatePassword() {
            passwordUpdates += 1;
            passwordUpdateStarted();
            await passwordUpdateGate;
            return "updated";
          },
        }));
        const concurrentPasswords = [
          passwordService.changePassword(issued[0]!.accessToken, { currentPassword: "old-password", newPassword: "new-password-one" }),
          passwordService.changePassword(issued[0]!.accessToken, { currentPassword: "old-password", newPassword: "new-password-two" }),
        ];
        await passwordsVerified;
        releasePasswordVerification();
        await updateStarted;
        const firstPasswordOutcome = await Promise.race(concurrentPasswords.map((promise) => promise.then(
          () => ({ kind: "fulfilled" as const }),
          (reason: unknown) => ({ kind: "rejected" as const, reason }),
        )));
        expect(firstPasswordOutcome).toMatchObject({ kind: "rejected", reason: { code: "PASSWORD_CHANGE_IN_PROGRESS" } });
        releasePasswordUpdate();
        const passwordResults = await Promise.allSettled(concurrentPasswords);
        expect(passwordUpdates).toBe(1);
        expect(passwordResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const passwordFailure = passwordResults.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
        expect(passwordFailure).toMatchObject({ code: "PASSWORD_CHANGE_IN_PROGRESS" });

        await admin.query("UPDATE crm.employee_security_states SET credential_state = 'ready', login_locked_until = NULL WHERE employee_id = $1", [employeeId]);
        let releaseSignIn!: () => void;
        let signInStarted!: () => void;
        const signInGate = new Promise<void>((resolve) => { releaseSignIn = resolve; });
        const providerStarted = new Promise<void>((resolve) => { signInStarted = resolve; });
        let bans = 0;
        let revokes = 0;
        const signInService = service(runtimeUrl, provider({
          async signInWithPassword() {
            signInStarted();
            await signInGate;
            return { kind: "success", session: providerSession() };
          },
          async banUser() { bans += 1; return "banned"; },
          async revokeSession() { revokes += 1; return "revoked"; },
        }));
        const signIn = signInService.signIn({ login: "security.test", password: "correct", attemptId: "00000000-0000-7000-8000-000000000110" });
        await providerStarted;
        await admin.query("UPDATE crm.employee_security_states SET login_locked_until = clock_timestamp() + interval '15 minutes' WHERE employee_id = $1", [employeeId]);
        releaseSignIn();
        await expect(signIn).rejects.toMatchObject({ code: "LOGIN_LOCKED" });
        expect(bans).toBe(0);
        expect(revokes).toBe(1);

        let reconciledBans = 0;
        let reconciledProvisions = 0;
        const lifecycleProvider = provider({
          async banUser() { reconciledBans += 1; return "banned"; },
          async createUser() { reconciledProvisions += 1; return "created"; },
        });
        const lifecycleService = new EmployeeService({
          withDatabase: (callback) => withRequestDatabase({ connectionString: runtimeUrl }, callback),
          provider: lifecycleProvider,
          tokenCipher,
          providerNamespace: "integration",
        });
        await admin.query(`INSERT INTO crm.security_outbox (id, operation, aggregate_type, aggregate_id, payload) VALUES
          ('00000000-0000-7000-8000-000000000112', 'provider_user_ban', 'employee', $1, $2::jsonb),
          ('00000000-0000-7000-8000-000000000113', 'provider_user_provision', 'employment_epoch', $3, $4::jsonb)`, [
          employeeId,
          JSON.stringify({ subjectId }),
          epochId,
          JSON.stringify({ subjectId, employeeId, recoveryEmail: "security.test@example.invalid", marker: "test-marker", passwordCiphertext: await tokenCipher.encrypt("temporary-password") }),
        ]);
        await lifecycleService.reconcileProviderEffects();
        expect(reconciledBans).toBe(1);
        expect(reconciledProvisions).toBe(1);
        await expect(admin.query("SELECT state, payload FROM crm.security_outbox WHERE id IN ($1, $2) ORDER BY id", [
          "00000000-0000-7000-8000-000000000112",
          "00000000-0000-7000-8000-000000000113",
        ])).resolves.toMatchObject({ rows: [{ state: "completed", payload: {} }, { state: "completed", payload: {} }] });
      } finally {
        await admin.end();
      }
    });
  }, 90_000);
});
