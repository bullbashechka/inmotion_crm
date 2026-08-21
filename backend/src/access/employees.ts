import { sql } from "drizzle-orm";

import { AccessControlService, AuthorizationError, parseRecordScope, type RecordScope } from "./control";
import { canonicalizeEmail, canonicalizeUsername, createOpaqueToken, type AuthTokenCipher } from "../auth/crypto";
import type { AuthProvider } from "../auth/provider";
import type { RequestDatabase } from "../db/integrity";
import { createUuidV7 } from "../db/uuidv7";

type DatabaseRunner = <T>(callback: (database: RequestDatabase) => Promise<T>) => Promise<T>;
type Actor = { employeeId: string; employmentEpochId: string };

type CurrentEmployee = { employmentEpochId: string; accessState: string; employmentState: string; providerSubjectId: string };
type EmployeeProviderEffect = { id: string; operation: "provider_user_ban" | "provider_user_provision" | "provider_user_restore"; aggregateId: string; payload: unknown };

function payloadString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null || !(key in payload)) return null;
  const value = Reflect.get(payload, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class EmployeeServiceError extends Error {
  constructor(
    readonly code: "EMPLOYEE_CONFLICT" | "OFFBOARDING_REASSIGNMENT_REQUIRED" | "EMPLOYEE_NOT_FOUND" | "PROVISIONING_UNAVAILABLE" | "IDENTITY_RECONCILIATION_REQUIRED",
    readonly status: 404 | 409 | 422 | 503,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "EmployeeServiceError";
  }
}

export type CreateEmployeeInput = {
  fullName: string;
  contactEmail: string;
  login: string;
  roleId: string;
  reason: string;
};

export type CreatedEmployee = {
  employeeId: string;
  employmentEpochId: string;
  provisioningState: "pending_activation" | "provisioning";
  /** Only the deployment bootstrap script receives an initial one-time secret. */
  temporaryPassword?: string;
};

export type OffboardEmployeeInput = {
  employeeId: string;
  leadReplacementEmployeeId?: string;
  medicalCaseReplacementEmployeeId?: string;
  confirmedNoReassignment?: boolean;
  reason: string;
};

export type RehireEmployeeInput = {
  employeeId: string;
  contactEmail: string;
  login: string;
  roleId: string;
  reason: string;
};

export type TemporaryPasswordIssued = { temporaryPassword: string };

export type EmployeeSummary = {
  id: string;
  fullName: string;
  login: string | null;
  roles: string[];
  accessState: "active" | "pending_activation" | "suspended" | "security_quarantined" | "terminated";
  credentialState: string;
  temporaryPasswordExpiresAt: string | null;
  lastSignInAt: string | null;
  version: number;
};

export type EmployeeDetail = EmployeeSummary & {
  recoveryEmail: string;
  assignedRoles: { id: string; code: string; source: string }[];
  effectivePermissions: { permissionCode: string; resourceFamily: string; scope: RecordScope; source: "role" | "override"; sourceLabel: string; expiresAt: string | null }[];
  overrides: { permissionCode: string; mode: "replace" | "deny"; scope: { records: RecordScope } | null; expiresAt: string | null; reason: string }[];
};

export type EmployeeServiceOptions = {
  withDatabase: DatabaseRunner;
  provider: AuthProvider;
  tokenCipher: AuthTokenCipher;
  providerNamespace: string;
  accessControl?: AccessControlService;
};

function temporaryPassword(): string {
  // The password is created only for the provider request and immediate response.
  return `T-${createOpaqueToken(24)}-a9!`;
}

async function writeSecurityAudit(
  database: RequestDatabase,
  input: { actorEmployeeId: string | null; action: string; entityType: string; entityId: string; reason: string; after?: Record<string, unknown> },
): Promise<void> {
  await database.execute(sql`
    INSERT INTO crm.audit_entries (
      id, actor_employee_id, action, category, view_scope,
      entity_type, entity_id, reason, after
    ) VALUES (
      ${createUuidV7()}::uuid,
      ${input.actorEmployeeId}::uuid,
      ${input.action}::text,
      'security'::text,
      'employees'::text,
      ${input.entityType}::text,
      ${input.entityId}::uuid,
      ${input.reason}::text,
      ${input.after === undefined ? null : JSON.stringify(input.after)}::jsonb
    )
  `);
}

async function activeEmployee(database: RequestDatabase, employeeId: string): Promise<CurrentEmployee | null> {
  const result = await database.execute<CurrentEmployee>(sql`
    SELECT security.employment_epoch_id AS "employmentEpochId", security.access_state AS "accessState",
           epoch.state AS "employmentState", binding.provider_subject_id AS "providerSubjectId"
    FROM crm.employee_security_states AS security
    JOIN crm.employment_epochs AS epoch ON epoch.id = security.employment_epoch_id
    JOIN crm.auth_bindings AS binding ON binding.employment_epoch_id = epoch.id AND binding.state = 'active'
    WHERE security.employee_id = ${employeeId}::uuid
    LIMIT 1
  `);
  const row = result.rows[0];
  return row !== undefined && row.accessState === "active" && row.employmentState === "active" ? row : null;
}

function scopeRank(scope: RecordScope): number {
  return scope === "all" ? 3 : scope === "assigned" ? 2 : 1;
}

function toEmployeeSummary(row: {
  id: string;
  fullName: string;
  login: string | null;
  roles: string[] | null;
  accessState: string;
  credentialState: string;
  temporaryPasswordExpiresAt: Date | null;
  lastSignInAt: Date | null;
  version: number;
}): EmployeeSummary {
  const accessState = row.accessState === "active" && row.credentialState === "unready"
    ? "pending_activation"
    : row.accessState === "active" || row.accessState === "suspended" || row.accessState === "security_quarantined" || row.accessState === "terminated"
      ? row.accessState
      : "pending_activation";
  return {
    id: row.id,
    fullName: row.fullName,
    login: row.login,
    roles: row.roles ?? [],
    accessState,
    credentialState: row.credentialState,
    temporaryPasswordExpiresAt: row.temporaryPasswordExpiresAt?.toISOString() ?? null,
    lastSignInAt: row.lastSignInAt?.toISOString() ?? null,
    version: row.version,
  };
}

export class EmployeeService {
  private readonly accessControl: AccessControlService;

  constructor(private readonly options: EmployeeServiceOptions) {
    this.accessControl = options.accessControl ?? new AccessControlService();
  }

  async listEmployees(actor: Actor): Promise<EmployeeSummary[]> {
    return this.options.withDatabase(async (database) => {
      await this.accessControl.requirePermission(database, actor, "employees.manage", "all");
      const result = await database.execute<{
        id: string;
        fullName: string;
        login: string | null;
        roles: string[] | null;
        accessState: string;
        credentialState: string;
        temporaryPasswordExpiresAt: Date | null;
        lastSignInAt: Date | null;
        version: number;
      }>(sql`
        SELECT
          employee.id,
          employee.full_name AS "fullName",
          claim.canonical_login AS login,
          array_remove(array_agg(DISTINCT role.code), NULL) AS roles,
          security.access_state AS "accessState",
          security.credential_state AS "credentialState",
          security.temporary_password_expires_at AS "temporaryPasswordExpiresAt",
          max(attempt.occurred_at) FILTER (WHERE attempt.outcome = 'succeeded') AS "lastSignInAt",
          employee.version
        FROM crm.employees AS employee
        LEFT JOIN crm.employee_security_states AS security ON security.employee_id = employee.id
        LEFT JOIN crm.login_claims AS claim
          ON claim.employee_id = employee.id
         AND claim.employment_epoch_id = security.employment_epoch_id
         AND claim.state = 'active'
        LEFT JOIN crm.role_assignments AS assignment
          ON assignment.employee_id = employee.id
         AND assignment.employment_epoch_id = security.employment_epoch_id
         AND assignment.revoked_at IS NULL
        LEFT JOIN crm.roles AS role ON role.id = assignment.role_id AND role.archived_at IS NULL
        LEFT JOIN crm.auth_login_attempts AS attempt ON attempt.employee_id = employee.id
        GROUP BY employee.id, claim.canonical_login, security.access_state, security.credential_state,
          security.temporary_password_expires_at, employee.version
        ORDER BY employee.full_name
      `);
      return result.rows.map((row) => toEmployeeSummary(row));
    });
  }

  async getEmployee(actor: Actor, employeeId: string): Promise<EmployeeDetail> {
    return this.options.withDatabase(async (database) => {
      await this.accessControl.requirePermission(database, actor, "employees.manage", "all");
      const summaryRows = await database.execute<{
        id: string;
        fullName: string;
        login: string | null;
        roles: string[] | null;
        accessState: string;
        credentialState: string;
        temporaryPasswordExpiresAt: Date | null;
        lastSignInAt: Date | null;
        version: number;
        recoveryEmail: string;
        employmentEpochId: string;
      }>(sql`
        SELECT
          employee.id,
          employee.full_name AS "fullName",
          claim.canonical_login AS login,
          array_remove(array_agg(DISTINCT role.code), NULL) AS roles,
          security.access_state AS "accessState",
          security.credential_state AS "credentialState",
          security.temporary_password_expires_at AS "temporaryPasswordExpiresAt",
          max(attempt.occurred_at) FILTER (WHERE attempt.outcome = 'succeeded') AS "lastSignInAt",
          employee.version,
          employee.recovery_email AS "recoveryEmail",
          security.employment_epoch_id AS "employmentEpochId"
        FROM crm.employees AS employee
        JOIN crm.employee_security_states AS security ON security.employee_id = employee.id
        LEFT JOIN crm.login_claims AS claim
          ON claim.employee_id = employee.id
         AND claim.employment_epoch_id = security.employment_epoch_id
         AND claim.state = 'active'
        LEFT JOIN crm.role_assignments AS assignment
          ON assignment.employee_id = employee.id
         AND assignment.employment_epoch_id = security.employment_epoch_id
         AND assignment.revoked_at IS NULL
        LEFT JOIN crm.roles AS role ON role.id = assignment.role_id AND role.archived_at IS NULL
        LEFT JOIN crm.auth_login_attempts AS attempt ON attempt.employee_id = employee.id
        WHERE employee.id = ${employeeId}::uuid
        GROUP BY employee.id, claim.canonical_login, security.access_state, security.credential_state,
          security.temporary_password_expires_at, employee.version, employee.recovery_email, security.employment_epoch_id
      `);
      const base = summaryRows.rows[0];
      if (base === undefined) throw new EmployeeServiceError("EMPLOYEE_NOT_FOUND", 404, false, "Сотрудник не найден.");
      const [roles, grants, overrides] = await Promise.all([
        database.execute<{ id: string; code: string; reason: string }>(sql`
          SELECT role.id, role.code, assignment.reason
          FROM crm.role_assignments AS assignment
          JOIN crm.roles AS role ON role.id = assignment.role_id AND role.archived_at IS NULL
          WHERE assignment.employee_id = ${employeeId}::uuid
            AND assignment.employment_epoch_id = ${base.employmentEpochId}::uuid
            AND assignment.revoked_at IS NULL
          ORDER BY role.code
        `),
        database.execute<{ permissionCode: string; resourceFamily: string; scope: unknown; roleCode: string }>(sql`
          SELECT grant.permission_code AS "permissionCode", catalog.resource_family AS "resourceFamily", grant.scope, role.code AS "roleCode"
          FROM crm.role_assignments AS assignment
          JOIN crm.roles AS role ON role.id = assignment.role_id AND role.archived_at IS NULL
          JOIN crm.role_grants AS grant ON grant.role_revision_id = role.current_revision_id
          JOIN crm.permission_catalog AS catalog ON catalog.code = grant.permission_code
          WHERE assignment.employee_id = ${employeeId}::uuid
            AND assignment.employment_epoch_id = ${base.employmentEpochId}::uuid
            AND assignment.revoked_at IS NULL
        `),
        database.execute<{ permissionCode: string; mode: "replace" | "deny"; scope: unknown; expiresAt: Date | null; reason: string }>(sql`
          SELECT permission_code AS "permissionCode", mode, scope, expires_at AS "expiresAt", reason
          FROM crm.employee_permission_overrides
          WHERE employee_id = ${employeeId}::uuid
            AND employment_epoch_id = ${base.employmentEpochId}::uuid
            AND revoked_at IS NULL
          ORDER BY permission_code
        `),
      ]);
      const effective = new Map<string, EmployeeDetail["effectivePermissions"][number]>();
      for (const grant of grants.rows) {
        const scope = parseRecordScope(grant.scope);
        if (scope === null) continue;
        const previous = effective.get(grant.permissionCode);
        if (previous === undefined || scopeRank(scope) > scopeRank(previous.scope)) {
          effective.set(grant.permissionCode, { permissionCode: grant.permissionCode, resourceFamily: grant.resourceFamily, scope, source: "role", sourceLabel: `Роль ${grant.roleCode}`, expiresAt: null });
        }
      }
      for (const override of overrides.rows) {
        const expired = override.expiresAt !== null && override.expiresAt.getTime() <= Date.now();
        if (expired || override.mode === "deny") {
          effective.delete(override.permissionCode);
          continue;
        }
        const scope = parseRecordScope(override.scope);
        if (scope === null) {
          effective.delete(override.permissionCode);
          continue;
        }
        const inherited = effective.get(override.permissionCode);
        effective.set(override.permissionCode, {
          permissionCode: override.permissionCode,
          resourceFamily: inherited?.resourceFamily ?? "custom",
          scope,
          source: "override",
          sourceLabel: "Индивидуальное исключение",
          expiresAt: override.expiresAt?.toISOString() ?? null,
        });
      }
      return {
        ...toEmployeeSummary(base),
        recoveryEmail: base.recoveryEmail,
        assignedRoles: roles.rows.map((role) => ({ id: role.id, code: role.code, source: role.reason })),
        effectivePermissions: [...effective.values()].sort((left, right) => left.permissionCode.localeCompare(right.permissionCode)),
        overrides: overrides.rows.map((override) => ({
          permissionCode: override.permissionCode,
          mode: override.mode,
          scope: parseRecordScope(override.scope) === null ? null : { records: parseRecordScope(override.scope)! },
          expiresAt: override.expiresAt?.toISOString() ?? null,
          reason: override.reason,
        })),
      };
    });
  }

  async createEmployee(actor: Actor, input: CreateEmployeeInput): Promise<CreatedEmployee> {
    const login = canonicalizeUsername(input.login);
    const contactEmail = canonicalizeEmail(input.contactEmail);
    const fullName = input.fullName.trim();
    const reason = input.reason.trim();
    if (login === null || contactEmail === null || fullName === "" || reason === "") {
      throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 422, false, "Проверьте данные сотрудника.");
    }
    const password = temporaryPassword();
    const passwordCiphertext = await this.options.tokenCipher.encrypt(password);
    const reservation = await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await this.accessControl.requirePermission(transaction, actor, "employees.manage", "all");
      await this.accessControl.assertRoleAssignmentAllowed(transaction, actor, "00000000-0000-7000-8000-000000000000", input.roleId);
      const existing = await transaction.execute<{ id: string }>(sql`
        SELECT id FROM crm.login_claims WHERE canonical_login = ${login}::text LIMIT 1 FOR UPDATE
      `);
      if (existing.rows[0] !== undefined) throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 409, false, "Этот логин уже зарезервирован.");
      const role = await transaction.execute<{ id: string }>(sql`
        SELECT id FROM crm.roles WHERE id = ${input.roleId}::uuid AND archived_at IS NULL LIMIT 1
      `);
      if (role.rows[0] === undefined) throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 422, false, "Выбранная роль недоступна.");
      const employeeId = createUuidV7();
      const employmentEpochId = createUuidV7();
      const subjectId = createUuidV7();
      const bindingId = createUuidV7();
      const marker = createOpaqueToken();
      await transaction.execute(sql`
        INSERT INTO crm.employees (id, full_name, email, contact_email, recovery_email, created_at, updated_at)
        VALUES (${employeeId}::uuid, ${fullName}::text, ${contactEmail}::text, ${contactEmail}::text, ${contactEmail}::text, clock_timestamp(), clock_timestamp())
      `);
      await transaction.execute(sql`
        INSERT INTO crm.employment_epochs (id, employee_id, sequence, state)
        VALUES (${employmentEpochId}::uuid, ${employeeId}::uuid, 1, 'provider_creating')
      `);
      await transaction.execute(sql`
        INSERT INTO crm.employee_security_states (employee_id, employment_epoch_id, access_state, credential_state)
        VALUES (${employeeId}::uuid, ${employmentEpochId}::uuid, 'suspended', 'unready')
      `);
      await transaction.execute(sql`
        INSERT INTO crm.login_claims (id, canonical_login, employee_id, employment_epoch_id, state)
        VALUES (${createUuidV7()}::uuid, ${login}::text, ${employeeId}::uuid, ${employmentEpochId}::uuid, 'reserved')
      `);
      await transaction.execute(sql`
        INSERT INTO crm.auth_bindings (id, employment_epoch_id, provider_namespace, provider_subject_id, provider_marker, state)
        VALUES (${bindingId}::uuid, ${employmentEpochId}::uuid, ${this.options.providerNamespace}::text, ${subjectId}::uuid, ${marker}::text, 'reserved')
      `);
      await transaction.execute(sql`
        INSERT INTO crm.role_assignments (id, employee_id, employment_epoch_id, role_id, assigned_by_employee_id, reason)
        VALUES (${createUuidV7()}::uuid, ${employeeId}::uuid, ${employmentEpochId}::uuid, ${input.roleId}::uuid, ${actor.employeeId}::uuid, ${reason}::text)
      `);
      await transaction.execute(sql`
        INSERT INTO crm.security_outbox (id, operation, aggregate_type, aggregate_id, expected_epoch, payload)
        VALUES (
          ${createUuidV7()}::uuid, 'provider_user_provision', 'employment_epoch', ${employmentEpochId}::uuid, 1,
          ${JSON.stringify({ subjectId, recoveryEmail: contactEmail, marker, employeeId, bindingId, passwordCiphertext })}::jsonb
        )
      `);
      await writeSecurityAudit(transaction, { actorEmployeeId: actor.employeeId, action: "employee.provisioning.started", entityType: "employee", entityId: employeeId, reason, after: { employmentEpochId } });
      return { employeeId, employmentEpochId, subjectId, bindingId, marker, login, recoveryEmail: contactEmail };
    }));

    const provisioned = await this.options.provider.createUser({ subjectId: reservation.subjectId, login: reservation.recoveryEmail, temporaryPassword: password, marker: reservation.marker });
    const exactIdentity = provisioned === "unavailable" ? "unavailable" : await this.options.provider.getUserById(reservation.subjectId);
    if (exactIdentity === "unavailable") {
      await this.markProvisionPending(reservation.employeeId, "provider_unavailable");
      throw new EmployeeServiceError("PROVISIONING_UNAVAILABLE", 503, true, "Учётная запись создаётся. Повторите проверку позже; пароль не был выдан.");
    }
    if (exactIdentity === null || exactIdentity.subjectId !== reservation.subjectId || exactIdentity.login !== reservation.recoveryEmail || exactIdentity.marker !== reservation.marker) {
      await this.failProvision(reservation.employeeId, reservation.employmentEpochId, "provider_identity_mismatch");
      throw new EmployeeServiceError("IDENTITY_RECONCILIATION_REQUIRED", 409, false, "Учётная запись требует проверки безопасности.");
    }
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE crm.auth_bindings
        SET state = 'active', confirmed_at = clock_timestamp()
        WHERE id = ${reservation.bindingId}::uuid
          AND employment_epoch_id = ${reservation.employmentEpochId}::uuid
          AND state = 'reserved'
      `);
      await transaction.execute(sql`
        UPDATE crm.login_claims SET state = 'active'
        WHERE employment_epoch_id = ${reservation.employmentEpochId}::uuid AND state = 'reserved'
      `);
      await transaction.execute(sql`
        UPDATE crm.employment_epochs
        SET state = 'active', started_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
        WHERE id = ${reservation.employmentEpochId}::uuid AND state = 'provider_creating'
      `);
      await transaction.execute(sql`
        UPDATE crm.employee_security_states
        SET access_state = 'active', credential_state = 'unready', temporary_password_expires_at = NULL, provider_reconciled_at = clock_timestamp(),
            updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${reservation.employeeId}::uuid AND employment_epoch_id = ${reservation.employmentEpochId}::uuid
      `);
      await transaction.execute(sql`
        UPDATE crm.employees
        SET current_employment_epoch_id = ${reservation.employmentEpochId}::uuid, updated_at = clock_timestamp(), version = version + 1
        WHERE id = ${reservation.employeeId}::uuid
      `);
      await transaction.execute(sql`
        UPDATE crm.security_outbox
        SET state = 'completed', payload = '{}'::jsonb, completed_at = clock_timestamp()
        WHERE operation = 'provider_user_provision' AND aggregate_type = 'employment_epoch' AND aggregate_id = ${reservation.employmentEpochId}::uuid
      `);
      await writeSecurityAudit(transaction, { actorEmployeeId: actor.employeeId, action: "employee.provisioned", entityType: "employee", entityId: reservation.employeeId, reason, after: { employmentEpochId: reservation.employmentEpochId } });
    }));
    return { employeeId: reservation.employeeId, employmentEpochId: reservation.employmentEpochId, provisioningState: "pending_activation" };
  }

  /**
   * Private deployment operation, intentionally not registered as an HTTP
   * route. It may run once on an empty clinic and installs the first leader,
   * after which all employee management goes through normal RBAC commands.
   */
  async bootstrapInitialLeader(input: Omit<CreateEmployeeInput, "roleId">): Promise<CreatedEmployee> {
    const login = canonicalizeUsername(input.login);
    const contactEmail = canonicalizeEmail(input.contactEmail);
    const fullName = input.fullName.trim();
    const reason = input.reason.trim();
    if (login === null || contactEmail === null || fullName === "" || reason === "") {
      throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 422, false, "Проверьте данные первого руководителя.");
    }
    const resumable = await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const result = await transaction.execute<{
        employeeId: string;
        employmentEpochId: string;
        subjectId: string;
        bindingId: string;
        marker: string;
        recoveryEmail: string;
        login: string;
        fullName: string;
        passwordCiphertext: string;
      }>(sql`
        SELECT employee.id AS "employeeId", epoch.id AS "employmentEpochId",
               binding.provider_subject_id AS "subjectId", binding.id AS "bindingId",
               binding.provider_marker AS marker, employee.recovery_email AS "recoveryEmail",
               claim.canonical_login AS login, employee.full_name AS "fullName",
               effect.payload ->> 'passwordCiphertext' AS "passwordCiphertext"
        FROM crm.security_outbox AS effect
        JOIN crm.employment_epochs AS epoch ON epoch.id = effect.aggregate_id AND epoch.state = 'provider_creating'
        JOIN crm.employees AS employee ON employee.id = epoch.employee_id
        JOIN crm.auth_bindings AS binding ON binding.employment_epoch_id = epoch.id AND binding.state = 'reserved'
        JOIN crm.login_claims AS claim ON claim.employment_epoch_id = epoch.id AND claim.state = 'reserved'
        WHERE effect.operation = 'provider_user_provision'
          AND effect.aggregate_type = 'employment_epoch'
          AND effect.state IN ('pending', 'processing')
          AND effect.payload ->> 'bootstrap' = 'true'
        LIMIT 1
        FOR UPDATE OF effect, epoch, employee, binding, claim
      `);
      const row = result.rows[0];
      if (row !== undefined) await transaction.execute(sql`
        UPDATE crm.security_outbox
        SET state = 'processing', next_attempt_at = clock_timestamp() + interval '5 minutes'
        WHERE operation = 'provider_user_provision' AND aggregate_id = ${row.employmentEpochId}::uuid
      `);
      return row ?? null;
    }));
    let password: string;
    let reservation: { employeeId: string; employmentEpochId: string; subjectId: string; bindingId: string; marker: string; login: string; recoveryEmail: string };
    if (resumable !== null) {
      if (resumable.login !== login || resumable.recoveryEmail !== contactEmail || resumable.fullName !== fullName) {
        throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 409, false, "Повторите bootstrap с теми же данными первого руководителя.");
      }
      try {
        password = await this.options.tokenCipher.decrypt(resumable.passwordCiphertext);
      } catch {
        throw new EmployeeServiceError("IDENTITY_RECONCILIATION_REQUIRED", 409, false, "Bootstrap требует ручной проверки безопасности.");
      }
      reservation = resumable;
    } else {
      password = temporaryPassword();
      const passwordCiphertext = await this.options.tokenCipher.encrypt(password);
      reservation = await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
        const state = await transaction.execute<{ initialized: Date | null }>(sql`
          SELECT security_initialized_at AS initialized FROM crm.clinic_security_states LIMIT 1 FOR UPDATE
        `);
        const employees = await transaction.execute<{ count: string }>(sql`SELECT count(*) FROM crm.employees`);
        if (state.rows[0]?.initialized != null || Number(employees.rows[0]?.count ?? "0") !== 0) {
          throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 409, false, "Первый руководитель уже создан или клиника не пуста.");
        }
        const employeeId = createUuidV7();
        const employmentEpochId = createUuidV7();
        const subjectId = createUuidV7();
        const bindingId = createUuidV7();
        const marker = createOpaqueToken();
        await transaction.execute(sql`
          INSERT INTO crm.employees (id, full_name, email, contact_email, recovery_email, created_at, updated_at)
          VALUES (${employeeId}::uuid, ${fullName}::text, ${contactEmail}::text, ${contactEmail}::text, ${contactEmail}::text, clock_timestamp(), clock_timestamp())
        `);
        await transaction.execute(sql`INSERT INTO crm.employment_epochs (id, employee_id, sequence, state) VALUES (${employmentEpochId}::uuid, ${employeeId}::uuid, 1, 'provider_creating')`);
        await transaction.execute(sql`INSERT INTO crm.employee_security_states (employee_id, employment_epoch_id, access_state, credential_state) VALUES (${employeeId}::uuid, ${employmentEpochId}::uuid, 'suspended', 'unready')`);
        await transaction.execute(sql`INSERT INTO crm.login_claims (id, canonical_login, employee_id, employment_epoch_id, state) VALUES (${createUuidV7()}::uuid, ${login}::text, ${employeeId}::uuid, ${employmentEpochId}::uuid, 'reserved')`);
        await transaction.execute(sql`INSERT INTO crm.auth_bindings (id, employment_epoch_id, provider_namespace, provider_subject_id, provider_marker, state) VALUES (${bindingId}::uuid, ${employmentEpochId}::uuid, ${this.options.providerNamespace}::text, ${subjectId}::uuid, ${marker}::text, 'reserved')`);
        await transaction.execute(sql`
          INSERT INTO crm.role_assignments (id, employee_id, employment_epoch_id, role_id, reason)
          VALUES (${createUuidV7()}::uuid, ${employeeId}::uuid, ${employmentEpochId}::uuid, '00000000-0000-7000-8000-000000000401'::uuid, ${reason}::text)
        `);
        await transaction.execute(sql`
          INSERT INTO crm.security_outbox (id, operation, aggregate_type, aggregate_id, expected_epoch, payload)
          VALUES (${createUuidV7()}::uuid, 'provider_user_provision', 'employment_epoch', ${employmentEpochId}::uuid, 1,
            ${JSON.stringify({ subjectId, recoveryEmail: contactEmail, marker, employeeId, bindingId, passwordCiphertext, bootstrap: "true" })}::jsonb)
        `);
        return { employeeId, employmentEpochId, subjectId, bindingId, marker, login, recoveryEmail: contactEmail };
      }));
    }
    const provisioned = await this.options.provider.createUser({ subjectId: reservation.subjectId, login: reservation.recoveryEmail, temporaryPassword: password, marker: reservation.marker });
    const exactIdentity = provisioned === "unavailable" ? "unavailable" : await this.options.provider.getUserById(reservation.subjectId);
    if (exactIdentity === "unavailable") {
      await this.markProvisionPending(reservation.employeeId, "bootstrap_provider_unavailable");
      throw new EmployeeServiceError("PROVISIONING_UNAVAILABLE", 503, true, "Учётная запись руководителя создаётся. Временный пароль не был выдан.");
    }
    if (exactIdentity === null || exactIdentity.subjectId !== reservation.subjectId || exactIdentity.login !== reservation.recoveryEmail || exactIdentity.marker !== reservation.marker) {
      await this.failProvision(reservation.employeeId, reservation.employmentEpochId, "bootstrap_provider_identity_mismatch");
      throw new EmployeeServiceError("IDENTITY_RECONCILIATION_REQUIRED", 409, false, "Учётная запись руководителя требует проверки безопасности.");
    }
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await transaction.execute(sql`UPDATE crm.auth_bindings SET state = 'active', confirmed_at = clock_timestamp() WHERE id = ${reservation.bindingId}::uuid AND state = 'reserved'`);
      await transaction.execute(sql`UPDATE crm.login_claims SET state = 'active' WHERE employment_epoch_id = ${reservation.employmentEpochId}::uuid AND state = 'reserved'`);
      await transaction.execute(sql`UPDATE crm.employment_epochs SET state = 'active', started_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1 WHERE id = ${reservation.employmentEpochId}::uuid AND state = 'provider_creating'`);
      await transaction.execute(sql`UPDATE crm.employee_security_states SET access_state = 'active', credential_state = 'temporary_password', temporary_password_expires_at = clock_timestamp() + interval '72 hours', provider_reconciled_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1 WHERE employee_id = ${reservation.employeeId}::uuid`);
      await transaction.execute(sql`UPDATE crm.employees SET current_employment_epoch_id = ${reservation.employmentEpochId}::uuid, updated_at = clock_timestamp(), version = version + 1 WHERE id = ${reservation.employeeId}::uuid`);
      await transaction.execute(sql`
        INSERT INTO crm.clinic_security_states (id, security_initialized_at)
        VALUES (${createUuidV7()}::uuid, clock_timestamp())
        ON CONFLICT ((true)) DO UPDATE
        SET security_initialized_at = EXCLUDED.security_initialized_at, updated_at = clock_timestamp()
        WHERE crm.clinic_security_states.security_initialized_at IS NULL
      `);
      await transaction.execute(sql`UPDATE crm.security_outbox SET state = 'completed', payload = '{}'::jsonb, completed_at = clock_timestamp() WHERE operation = 'provider_user_provision' AND aggregate_type = 'employment_epoch' AND aggregate_id = ${reservation.employmentEpochId}::uuid`);
      await writeSecurityAudit(transaction, { actorEmployeeId: null, action: "security.initial_leader.bootstrapped", entityType: "employee", entityId: reservation.employeeId, reason });
    }));
    return { employeeId: reservation.employeeId, employmentEpochId: reservation.employmentEpochId, provisioningState: "pending_activation", temporaryPassword: password };
  }

  /** A rehire retains the person and historic authorship but creates a new immutable employment identity. */
  async rehireEmployee(actor: Actor, input: RehireEmployeeInput): Promise<CreatedEmployee> {
    const login = canonicalizeUsername(input.login);
    const contactEmail = canonicalizeEmail(input.contactEmail);
    const reason = input.reason.trim();
    if (login === null || contactEmail === null || reason === "") throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 422, false, "Проверьте данные повторного найма.");
    const password = temporaryPassword();
    const passwordCiphertext = await this.options.tokenCipher.encrypt(password);
    const reservation = await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      if (!(await this.accessControl.isLeader(transaction, actor))) {
        throw new AuthorizationError("SENSITIVE_PERMISSION_REQUIRED", "Только руководитель может повторно принять сотрудника.");
      }
      const former = await transaction.execute<{ employeeId: string; oldEpochId: string; accessState: string; employmentState: string; providerSubjectId: string }>(sql`
        SELECT security.employee_id AS "employeeId", security.employment_epoch_id AS "oldEpochId", security.access_state AS "accessState", epoch.state AS "employmentState",
          binding.provider_subject_id AS "providerSubjectId"
        FROM crm.employee_security_states AS security
        JOIN crm.employment_epochs AS epoch ON epoch.id = security.employment_epoch_id
        JOIN crm.auth_bindings AS binding ON binding.employment_epoch_id = epoch.id AND binding.state = 'ended'
        WHERE security.employee_id = ${input.employeeId}::uuid
        LIMIT 1
        FOR UPDATE OF security, epoch
      `);
      const employee = former.rows[0];
      if (employee === undefined || employee.accessState !== "terminated" || employee.employmentState !== "terminated") {
        throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 409, false, "Повторный найм возможен только для уволенного сотрудника.");
      }
      const existingLogin = await transaction.execute<{ id: string; employeeId: string }>(sql`
        SELECT id, employee_id AS "employeeId" FROM crm.login_claims
        WHERE canonical_login = ${login}::text LIMIT 1 FOR UPDATE
      `);
      if (existingLogin.rows[0] !== undefined && existingLogin.rows[0].employeeId !== input.employeeId) {
        throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 409, false, "Этот логин закреплён за другим сотрудником.");
      }
      const role = await transaction.execute<{ id: string }>(sql`SELECT id FROM crm.roles WHERE id = ${input.roleId}::uuid AND archived_at IS NULL LIMIT 1`);
      if (role.rows[0] === undefined) throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 422, false, "Выбранная роль недоступна.");
      const sequenceResult = await transaction.execute<{ sequence: number }>(sql`SELECT COALESCE(max(sequence), 0) AS sequence FROM crm.employment_epochs WHERE employee_id = ${input.employeeId}::uuid`);
      const employmentEpochId = createUuidV7();
      const subjectId = employee.providerSubjectId;
      const bindingId = createUuidV7();
      const marker = createOpaqueToken();
      await transaction.execute(sql`INSERT INTO crm.employment_epochs (id, employee_id, sequence, state) VALUES (${employmentEpochId}::uuid, ${input.employeeId}::uuid, ${(sequenceResult.rows[0]?.sequence ?? 0) + 1}::integer, 'provider_creating')`);
      await transaction.execute(sql`
        UPDATE crm.employee_security_states
        SET employment_epoch_id = ${employmentEpochId}::uuid, access_state = 'suspended', credential_state = 'unready',
            login_failure_count = 0, login_locked_until = NULL, session_epoch = session_epoch + 1, credential_epoch = credential_epoch + 1,
            updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${input.employeeId}::uuid
      `);
      if (existingLogin.rows[0] === undefined) {
        await transaction.execute(sql`INSERT INTO crm.login_claims (id, canonical_login, employee_id, employment_epoch_id, state) VALUES (${createUuidV7()}::uuid, ${login}::text, ${input.employeeId}::uuid, ${employmentEpochId}::uuid, 'reserved')`);
      } else {
        await transaction.execute(sql`
          UPDATE crm.login_claims
          SET employment_epoch_id = ${employmentEpochId}::uuid, state = 'reserved', released_at = NULL
          WHERE id = ${existingLogin.rows[0].id}::uuid
        `);
      }
      await transaction.execute(sql`INSERT INTO crm.auth_bindings (id, employment_epoch_id, provider_namespace, provider_subject_id, provider_marker, state) VALUES (${bindingId}::uuid, ${employmentEpochId}::uuid, ${this.options.providerNamespace}::text, ${subjectId}::uuid, ${marker}::text, 'reserved')`);
      await transaction.execute(sql`INSERT INTO crm.role_assignments (id, employee_id, employment_epoch_id, role_id, assigned_by_employee_id, reason) VALUES (${createUuidV7()}::uuid, ${input.employeeId}::uuid, ${employmentEpochId}::uuid, ${input.roleId}::uuid, ${actor.employeeId}::uuid, ${reason}::text)`);
      await transaction.execute(sql`INSERT INTO crm.security_outbox (id, operation, aggregate_type, aggregate_id, expected_epoch, payload) VALUES (${createUuidV7()}::uuid, 'provider_user_restore', 'employment_epoch', ${employmentEpochId}::uuid, 1, ${JSON.stringify({ subjectId, recoveryEmail: contactEmail, marker, employeeId: input.employeeId, bindingId, passwordCiphertext })}::jsonb)`);
      return { employeeId: input.employeeId, employmentEpochId, subjectId, bindingId, marker, recoveryEmail: contactEmail };
    }));
    const provisioned = await this.options.provider.restoreUser({ subjectId: reservation.subjectId, password, marker: reservation.marker });
    const exactIdentity = provisioned === "unavailable" ? "unavailable" : await this.options.provider.getUserById(reservation.subjectId);
    if (exactIdentity === "unavailable") {
      await this.markProvisionPending(reservation.employeeId, "rehire_provider_unavailable");
      throw new EmployeeServiceError("PROVISIONING_UNAVAILABLE", 503, true, "Учётная запись создаётся. Временный пароль не был выдан.");
    }
    if (exactIdentity === null || exactIdentity.subjectId !== reservation.subjectId || exactIdentity.login !== reservation.recoveryEmail || exactIdentity.marker !== reservation.marker) {
      await this.failProvision(reservation.employeeId, reservation.employmentEpochId, "rehire_provider_identity_mismatch");
      throw new EmployeeServiceError("IDENTITY_RECONCILIATION_REQUIRED", 409, false, "Учётная запись требует проверки безопасности.");
    }
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await transaction.execute(sql`UPDATE crm.auth_bindings SET state = 'active', confirmed_at = clock_timestamp() WHERE id = ${reservation.bindingId}::uuid AND state = 'reserved'`);
      await transaction.execute(sql`UPDATE crm.login_claims SET state = 'active' WHERE employment_epoch_id = ${reservation.employmentEpochId}::uuid AND state = 'reserved'`);
      await transaction.execute(sql`UPDATE crm.employment_epochs SET state = 'active', started_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1 WHERE id = ${reservation.employmentEpochId}::uuid AND state = 'provider_creating'`);
      await transaction.execute(sql`UPDATE crm.employee_security_states SET access_state = 'active', credential_state = 'unready', temporary_password_expires_at = NULL, provider_reconciled_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1 WHERE employee_id = ${reservation.employeeId}::uuid AND employment_epoch_id = ${reservation.employmentEpochId}::uuid`);
      await transaction.execute(sql`UPDATE crm.employees SET contact_email = ${contactEmail}::text, email = ${contactEmail}::text, recovery_email = ${contactEmail}::text, current_employment_epoch_id = ${reservation.employmentEpochId}::uuid, updated_at = clock_timestamp(), version = version + 1 WHERE id = ${reservation.employeeId}::uuid`);
      await transaction.execute(sql`UPDATE crm.security_outbox SET state = 'completed', payload = '{}'::jsonb, completed_at = clock_timestamp() WHERE operation = 'provider_user_restore' AND aggregate_type = 'employment_epoch' AND aggregate_id = ${reservation.employmentEpochId}::uuid`);
      await writeSecurityAudit(transaction, { actorEmployeeId: actor.employeeId, action: "employee.rehired", entityType: "employee", entityId: reservation.employeeId, reason, after: { employmentEpochId: reservation.employmentEpochId } });
    }));
    return { employeeId: reservation.employeeId, employmentEpochId: reservation.employmentEpochId, provisioningState: "pending_activation" };
  }

  async unlockAccount(actor: Actor, employeeId: string, reason: string): Promise<void> {
    if (actor.employeeId === employeeId) throw new AuthorizationError("SELF_ESCALATION_DENIED", "Нельзя разблокировать собственную учётную запись.");
    if (reason.trim() === "") throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 422, false, "Укажите причину разблокировки.");
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await this.accessControl.requirePermission(transaction, actor, "employees.unlock", "all");
      const updated = await transaction.execute<{ id: string }>(sql`
        UPDATE crm.employee_security_states
        SET login_failure_count = 0, login_locked_until = NULL, updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${employeeId}::uuid
        RETURNING employee_id AS id
      `);
      if (updated.rows[0] === undefined) throw new EmployeeServiceError("EMPLOYEE_NOT_FOUND", 404, false, "Сотрудник не найден.");
      await writeSecurityAudit(transaction, { actorEmployeeId: actor.employeeId, action: "auth.login.unlocked", entityType: "employee", entityId: employeeId, reason: reason.trim() });
    }));
  }

  async issueTemporaryPassword(actor: Actor, employeeId: string, reason: string): Promise<TemporaryPasswordIssued> {
    if (actor.employeeId === employeeId) {
      throw new AuthorizationError("SELF_ESCALATION_DENIED", "Нельзя сбрасывать собственный пароль через административную операцию.");
    }
    if (reason.trim() === "") throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 422, false, "Укажите причину сброса пароля.");
    const operationId = createUuidV7();
    const target = await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await this.accessControl.requirePermission(transaction, actor, "employees.manage", "all");
      const result = await transaction.execute<{ employeeId: string; employmentEpochId: string; providerSubjectId: string; targetIsLeader: boolean }>(sql`
        SELECT security.employee_id AS "employeeId", security.employment_epoch_id AS "employmentEpochId", binding.provider_subject_id AS "providerSubjectId"
          , EXISTS (
            SELECT 1
            FROM crm.role_assignments AS assignment
            JOIN crm.roles AS role ON role.id = assignment.role_id
            WHERE assignment.employee_id = security.employee_id
              AND assignment.employment_epoch_id = security.employment_epoch_id
              AND assignment.revoked_at IS NULL
              AND role.system_kind = 'leader'
              AND role.archived_at IS NULL
          ) AS "targetIsLeader"
        FROM crm.employee_security_states AS security
        JOIN crm.employment_epochs AS epoch ON epoch.id = security.employment_epoch_id
        JOIN crm.auth_bindings AS binding ON binding.employment_epoch_id = epoch.id AND binding.state = 'active'
        WHERE security.employee_id = ${employeeId}::uuid
          AND security.access_state = 'active'
          AND epoch.state = 'active'
          AND security.credential_state IN ('unready', 'temporary_password', 'ready', 'password_change_required')
        LIMIT 1
        FOR UPDATE OF security, epoch, binding
      `);
      const identity = result.rows[0];
      if (identity === undefined) throw new EmployeeServiceError("EMPLOYEE_NOT_FOUND", 404, false, "Активный сотрудник не найден.");
      if (identity.targetIsLeader && !(await this.accessControl.isLeader(transaction, actor))) {
        throw new AuthorizationError("SENSITIVE_PERMISSION_REQUIRED", "Только другой руководитель может сбросить пароль руководителя.");
      }
      const claimed = await transaction.execute<{ employeeId: string }>(sql`
        UPDATE crm.employee_security_states
        SET credential_state = 'changing', credential_operation_id = ${operationId}::uuid, session_epoch = session_epoch + 1,
            updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${employeeId}::uuid
          AND employment_epoch_id = ${identity.employmentEpochId}::uuid
          AND credential_state IN ('unready', 'temporary_password', 'ready', 'password_change_required')
        RETURNING employee_id AS "employeeId"
      `);
      if (claimed.rows[0] === undefined) throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 409, false, "Смена пароля уже выполняется.");
      await transaction.execute(sql`
        UPDATE crm.crm_sessions
        SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = 'temporary_password_pending',
            updated_at = clock_timestamp(), revision = revision + 1
        WHERE employee_id = ${employeeId}::uuid AND status = 'active'
      `);
      return identity;
    }));
    const password = temporaryPassword();
    const updated = await this.options.provider.updatePassword({ subjectId: target.providerSubjectId, password });
    if (updated !== "updated") {
      await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
        await transaction.execute(sql`
          UPDATE crm.employee_security_states
          SET credential_state = 'reconciliation_required', credential_operation_id = NULL,
              updated_at = clock_timestamp(), version = version + 1
          WHERE employee_id = ${employeeId}::uuid
            AND credential_state = 'changing'
            AND credential_operation_id = ${operationId}::uuid
        `);
        await writeSecurityAudit(transaction, { actorEmployeeId: actor.employeeId, action: "employee.password.reset_reconciliation_required", entityType: "employee", entityId: employeeId, reason: "provider_update_ambiguous" });
      }));
      throw new EmployeeServiceError("PROVISIONING_UNAVAILABLE", 503, true, "Сброс требует проверки безопасности. Временный пароль не был выдан.");
    }
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const finalized = await transaction.execute<{ employeeId: string }>(sql`
        UPDATE crm.employee_security_states
        SET credential_state = 'temporary_password', credential_operation_id = NULL, temporary_password_expires_at = clock_timestamp() + interval '72 hours', credential_epoch = credential_epoch + 1,
            login_failure_count = 0, login_locked_until = NULL, updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${employeeId}::uuid AND employment_epoch_id = ${target.employmentEpochId}::uuid
          AND credential_state = 'changing'
          AND credential_operation_id = ${operationId}::uuid
        RETURNING employee_id AS "employeeId"
      `);
      if (finalized.rows[0] === undefined) throw new EmployeeServiceError("IDENTITY_RECONCILIATION_REQUIRED", 409, false, "Учётная запись требует проверки безопасности.");
      await transaction.execute(sql`
        UPDATE crm.auth_recovery_challenges
        SET state = 'expired', recovery_grant_hash = NULL
        WHERE employee_id = ${employeeId}::uuid
          AND state IN ('pending', 'verified')
      `);
      await writeSecurityAudit(transaction, { actorEmployeeId: actor.employeeId, action: "employee.password.temporary_issued", entityType: "employee", entityId: employeeId, reason: reason.trim() });
    }));
    return { temporaryPassword: password };
  }

  async offboardEmployee(actor: Actor, input: OffboardEmployeeInput): Promise<void> {
    if (actor.employeeId === input.employeeId) throw new AuthorizationError("SELF_ESCALATION_DENIED", "Нельзя оформить собственное увольнение.");
    if (input.reason.trim() === "") throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 422, false, "Укажите причину увольнения.");
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await this.accessControl.requireSensitivePermission(transaction, actor, "employees.offboard");
      const target = await activeEmployee(transaction, input.employeeId);
      if (target === null) throw new EmployeeServiceError("EMPLOYEE_NOT_FOUND", 404, false, "Активный сотрудник не найден.");
      const [leads, cases] = await Promise.all([
        transaction.execute<{ count: string }>(sql`
          SELECT count(*) FROM crm.leads
          WHERE assigned_employee_id = ${input.employeeId}::uuid AND archived_at IS NULL AND converted_patient_id IS NULL
        `),
        transaction.execute<{ count: string }>(sql`
          SELECT count(*) FROM crm.medical_cases
          WHERE responsible_employee_id = ${input.employeeId}::uuid AND archived_at IS NULL AND closed_at IS NULL
        `),
      ]);
      const leadCount = Number(leads.rows[0]?.count ?? "0");
      const caseCount = Number(cases.rows[0]?.count ?? "0");
      if (!input.confirmedNoReassignment && ((leadCount > 0 && input.leadReplacementEmployeeId === undefined) || (caseCount > 0 && input.medicalCaseReplacementEmployeeId === undefined))) {
        throw new EmployeeServiceError("OFFBOARDING_REASSIGNMENT_REQUIRED", 422, false, "Перед увольнением назначьте новых ответственных или подтвердите исключение.");
      }
      for (const replacementId of [input.leadReplacementEmployeeId, input.medicalCaseReplacementEmployeeId]) {
        if (replacementId !== undefined && (replacementId === input.employeeId || await activeEmployee(transaction, replacementId) === null)) {
          throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 422, false, "Новый ответственный должен быть другим активным сотрудником.");
        }
      }
      if (input.leadReplacementEmployeeId !== undefined) {
        await transaction.execute(sql`
          UPDATE crm.leads SET assigned_employee_id = ${input.leadReplacementEmployeeId}::uuid, updated_at = clock_timestamp(), version = version + 1
          WHERE assigned_employee_id = ${input.employeeId}::uuid AND archived_at IS NULL AND converted_patient_id IS NULL
        `);
      }
      if (input.confirmedNoReassignment && input.leadReplacementEmployeeId === undefined && leadCount > 0) {
        await transaction.execute(sql`
          INSERT INTO crm.unassigned_responsibilities (
            id, category_code, entity_type, entity_id, previous_employee_id, reason
          )
          SELECT md5('unassigned-lead:' || lead.id::text)::uuid, 'leads'::text, 'lead'::text, lead.id,
            ${input.employeeId}::uuid, ${input.reason.trim()}::text
          FROM crm.leads AS lead
          WHERE lead.assigned_employee_id = ${input.employeeId}::uuid
            AND lead.archived_at IS NULL AND lead.converted_patient_id IS NULL
          ON CONFLICT (category_code, entity_type, entity_id) WHERE resolved_at IS NULL DO NOTHING
        `);
        await transaction.execute(sql`
          UPDATE crm.leads SET assigned_employee_id = NULL, updated_at = clock_timestamp(), version = version + 1
          WHERE assigned_employee_id = ${input.employeeId}::uuid AND archived_at IS NULL AND converted_patient_id IS NULL
        `);
      }
      if (input.medicalCaseReplacementEmployeeId !== undefined) {
        await transaction.execute(sql`
          UPDATE crm.medical_cases SET responsible_employee_id = ${input.medicalCaseReplacementEmployeeId}::uuid, updated_at = clock_timestamp(), version = version + 1
          WHERE responsible_employee_id = ${input.employeeId}::uuid AND archived_at IS NULL AND closed_at IS NULL
        `);
      }
      if (input.confirmedNoReassignment && input.medicalCaseReplacementEmployeeId === undefined && caseCount > 0) {
        await transaction.execute(sql`
          INSERT INTO crm.unassigned_responsibilities (
            id, category_code, entity_type, entity_id, previous_employee_id, reason
          )
          SELECT md5('unassigned-medical-case:' || medical_case.id::text)::uuid, 'medical_cases'::text, 'medicalCase'::text, medical_case.id,
            ${input.employeeId}::uuid, ${input.reason.trim()}::text
          FROM crm.medical_cases AS medical_case
          WHERE medical_case.responsible_employee_id = ${input.employeeId}::uuid
            AND medical_case.archived_at IS NULL AND medical_case.closed_at IS NULL
          ON CONFLICT (category_code, entity_type, entity_id) WHERE resolved_at IS NULL DO NOTHING
        `);
        await transaction.execute(sql`
          UPDATE crm.medical_cases SET responsible_employee_id = NULL, updated_at = clock_timestamp(), version = version + 1
          WHERE responsible_employee_id = ${input.employeeId}::uuid AND archived_at IS NULL AND closed_at IS NULL
        `);
      }
      await transaction.execute(sql`
        UPDATE crm.crm_sessions
        SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = 'offboarded', updated_at = clock_timestamp(), revision = revision + 1
        WHERE employee_id = ${input.employeeId}::uuid AND status = 'active'
      `);
      await transaction.execute(sql`
        UPDATE crm.employee_security_states
        SET access_state = 'terminated', credential_state = 'disabled', credential_operation_id = NULL, session_epoch = session_epoch + 1,
            updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${input.employeeId}::uuid
      `);
      await transaction.execute(sql`
        UPDATE crm.auth_bindings SET state = 'ended', ended_at = clock_timestamp()
        WHERE employment_epoch_id = ${target.employmentEpochId}::uuid AND state = 'active'
      `);
      await transaction.execute(sql`
        UPDATE crm.login_claims SET state = 'tombstoned'
        WHERE employment_epoch_id = ${target.employmentEpochId}::uuid AND state = 'active'
      `);
      await transaction.execute(sql`
        UPDATE crm.employment_epochs
        SET state = 'terminated', ended_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
        WHERE id = ${target.employmentEpochId}::uuid AND state = 'active'
      `);
      await transaction.execute(sql`
        INSERT INTO crm.security_outbox (id, operation, aggregate_type, aggregate_id, expected_epoch, payload)
        VALUES (${createUuidV7()}::uuid, 'provider_user_ban', 'employee', ${input.employeeId}::uuid, NULL, ${JSON.stringify({ subjectId: target.providerSubjectId })}::jsonb)
        ON CONFLICT (operation, aggregate_type, aggregate_id) DO UPDATE
        SET payload = EXCLUDED.payload, state = 'pending', attempts = 0,
            next_attempt_at = clock_timestamp(), completed_at = NULL
      `);
      await writeSecurityAudit(transaction, {
        actorEmployeeId: actor.employeeId,
        action: "employee.offboarded",
        entityType: "employee",
        entityId: input.employeeId,
        reason: input.reason.trim(),
        after: { reassignedLeads: input.leadReplacementEmployeeId ?? null, reassignedMedicalCases: input.medicalCaseReplacementEmployeeId ?? null, confirmedNoReassignment: input.confirmedNoReassignment === true },
      });
    }));
  }

  /** Replays every employee-lifecycle provider effect from the durable outbox. */
  async reconcileProviderEffects(): Promise<void> {
    const effects = await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      const claimed = await transaction.execute<EmployeeProviderEffect>(sql`
        WITH candidates AS (
          SELECT id
          FROM crm.security_outbox
          WHERE operation IN ('provider_user_ban', 'provider_user_provision', 'provider_user_restore')
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
        RETURNING effect.id, effect.operation, effect.aggregate_id AS "aggregateId", effect.payload
      `);
      return claimed.rows;
    }));

    for (const effect of effects) {
      if (effect.operation === "provider_user_ban") {
        const subjectId = payloadString(effect.payload, "subjectId");
        const banned = subjectId === null ? "invalid" : await this.options.provider.banUser(subjectId).catch(() => "unavailable" as const);
        await this.finishProviderEffect(effect.id, banned === "banned" ? "completed" : banned === "invalid" ? "quarantined" : "pending");
        continue;
      }

      if (payloadString(effect.payload, "bootstrap") === "true") {
        // Only the private CLI may resume bootstrap because it is the sole
        // approved channel that can return the one-time leader credential.
        await this.finishProviderEffect(effect.id, "pending");
        continue;
      }

      const subjectId = payloadString(effect.payload, "subjectId");
      const recoveryEmail = payloadString(effect.payload, "recoveryEmail");
      const marker = payloadString(effect.payload, "marker");
      const employeeId = payloadString(effect.payload, "employeeId");
      const passwordCiphertext = payloadString(effect.payload, "passwordCiphertext");
      if ([subjectId, recoveryEmail, marker, employeeId, passwordCiphertext].some((value) => value === null)) {
        await this.finishProviderEffect(effect.id, "quarantined");
        continue;
      }

      let password: string;
      try {
        password = await this.options.tokenCipher.decrypt(passwordCiphertext!);
      } catch {
        await this.failProvision(employeeId!, effect.aggregateId, "provider_password_unreadable");
        await this.finishProviderEffect(effect.id, "quarantined");
        continue;
      }
      const dispatched = effect.operation === "provider_user_provision"
        ? await this.options.provider.createUser({ subjectId: subjectId!, login: recoveryEmail!, temporaryPassword: password, marker: marker! })
        : await this.options.provider.restoreUser({ subjectId: subjectId!, password, marker: marker! });
      if (dispatched === "unavailable") {
        await this.finishProviderEffect(effect.id, "pending");
        continue;
      }
      const exactIdentity = await this.options.provider.getUserById(subjectId!);
      if (exactIdentity === "unavailable") {
        await this.finishProviderEffect(effect.id, "pending");
        continue;
      }
      if (exactIdentity === null || exactIdentity.subjectId !== subjectId || exactIdentity.login !== recoveryEmail || exactIdentity.marker !== marker) {
        await this.failProvision(employeeId!, effect.aggregateId, "provider_identity_mismatch");
        await this.finishProviderEffect(effect.id, "quarantined");
        continue;
      }
      await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
        await transaction.execute(sql`
          UPDATE crm.auth_bindings
          SET state = 'active', confirmed_at = clock_timestamp()
          WHERE employment_epoch_id = ${effect.aggregateId}::uuid
            AND provider_subject_id = ${subjectId}::uuid
            AND state = 'reserved'
        `);
        await transaction.execute(sql`UPDATE crm.login_claims SET state = 'active' WHERE employment_epoch_id = ${effect.aggregateId}::uuid AND state = 'reserved'`);
        await transaction.execute(sql`
          UPDATE crm.employment_epochs
          SET state = 'active', started_at = COALESCE(started_at, clock_timestamp()), updated_at = clock_timestamp(), version = version + 1
          WHERE id = ${effect.aggregateId}::uuid AND state = 'provider_creating'
        `);
        await transaction.execute(sql`
          UPDATE crm.employee_security_states
          SET access_state = 'active', credential_state = 'unready', credential_operation_id = NULL,
              temporary_password_expires_at = NULL, provider_reconciled_at = clock_timestamp(),
              updated_at = clock_timestamp(), version = version + 1
          WHERE employee_id = ${employeeId}::uuid AND employment_epoch_id = ${effect.aggregateId}::uuid
        `);
        await transaction.execute(sql`
          UPDATE crm.employees
          SET contact_email = ${recoveryEmail}::text, email = ${recoveryEmail}::text, recovery_email = ${recoveryEmail}::text,
              current_employment_epoch_id = ${effect.aggregateId}::uuid, updated_at = clock_timestamp(), version = version + 1
          WHERE id = ${employeeId}::uuid
        `);
        if (payloadString(effect.payload, "bootstrap") === "true") {
          await transaction.execute(sql`
            INSERT INTO crm.clinic_security_states (id, security_initialized_at)
            VALUES (${createUuidV7()}::uuid, clock_timestamp())
            ON CONFLICT ((true)) DO UPDATE
            SET security_initialized_at = COALESCE(crm.clinic_security_states.security_initialized_at, EXCLUDED.security_initialized_at),
                updated_at = clock_timestamp()
          `);
        }
        await transaction.execute(sql`
          UPDATE crm.security_outbox
          SET state = 'completed', payload = '{}'::jsonb, completed_at = clock_timestamp()
          WHERE id = ${effect.id}::uuid AND state = 'processing'
        `);
        await writeSecurityAudit(transaction, { actorEmployeeId: null, action: "employee.provider_effect.reconciled", entityType: "employee", entityId: employeeId!, reason: effect.operation });
      }));
    }
  }

  private async finishProviderEffect(effectId: string, state: "completed" | "pending" | "quarantined"): Promise<void> {
    await this.options.withDatabase(async (database) => database.execute(sql`
      UPDATE crm.security_outbox
      SET state = ${state}::text,
          payload = CASE WHEN ${state}::text = 'completed' THEN '{}'::jsonb ELSE payload END,
          completed_at = CASE WHEN ${state}::text = 'completed' THEN clock_timestamp() ELSE NULL END,
          next_attempt_at = CASE WHEN ${state}::text = 'pending' THEN clock_timestamp() + interval '5 minutes' ELSE next_attempt_at END
      WHERE id = ${effectId}::uuid AND state = 'processing'
    `));
  }

  private async markProvisionPending(employeeId: string, reason: string): Promise<void> {
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE crm.security_outbox
        SET state = 'pending', attempts = attempts + 1, next_attempt_at = clock_timestamp() + interval '5 minutes'
        WHERE aggregate_type = 'employment_epoch'
          AND operation IN ('provider_user_provision', 'provider_user_restore')
          AND aggregate_id = (SELECT employment_epoch_id FROM crm.employee_security_states WHERE employee_id = ${employeeId}::uuid)
      `);
      await writeSecurityAudit(transaction, { actorEmployeeId: null, action: "employee.provisioning.pending", entityType: "employee", entityId: employeeId, reason });
    }));
  }

  private async failProvision(employeeId: string, employmentEpochId: string, reason: string): Promise<void> {
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE crm.employee_security_states
        SET access_state = 'security_quarantined', credential_state = 'reconciliation_required', credential_operation_id = NULL,
            updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${employeeId}::uuid
      `);
      await transaction.execute(sql`
        UPDATE crm.auth_bindings SET state = 'quarantined' WHERE employment_epoch_id = ${employmentEpochId}::uuid
      `);
      await transaction.execute(sql`
        UPDATE crm.employment_epochs SET state = 'quarantined', updated_at = clock_timestamp(), version = version + 1
        WHERE id = ${employmentEpochId}::uuid
      `);
      await writeSecurityAudit(transaction, { actorEmployeeId: null, action: "employee.provisioning.quarantined", entityType: "employee", entityId: employeeId, reason });
    }));
  }
}

export { AuthorizationError };
