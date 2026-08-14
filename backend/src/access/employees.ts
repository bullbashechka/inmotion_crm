import { sql } from "drizzle-orm";

import { AccessControlService, AuthorizationError } from "./control";
import { canonicalizeLogin, createOpaqueToken } from "../auth/crypto";
import type { AuthProvider } from "../auth/provider";
import type { RequestDatabase } from "../db/integrity";
import { createUuidV7 } from "../db/uuidv7";

type DatabaseRunner = <T>(callback: (database: RequestDatabase) => Promise<T>) => Promise<T>;
type Actor = { employeeId: string; employmentEpochId: string };

type CurrentEmployee = { employmentEpochId: string; accessState: string; employmentState: string };

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
  temporaryPassword: string;
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

export type EmployeeServiceOptions = {
  withDatabase: DatabaseRunner;
  provider: AuthProvider;
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
    SELECT security.employment_epoch_id AS "employmentEpochId", security.access_state AS "accessState", epoch.state AS "employmentState"
    FROM crm.employee_security_states AS security
    JOIN crm.employment_epochs AS epoch ON epoch.id = security.employment_epoch_id
    WHERE security.employee_id = ${employeeId}::uuid
    LIMIT 1
  `);
  const row = result.rows[0];
  return row !== undefined && row.accessState === "active" && row.employmentState === "active" ? row : null;
}

export class EmployeeService {
  private readonly accessControl: AccessControlService;

  constructor(private readonly options: EmployeeServiceOptions) {
    this.accessControl = options.accessControl ?? new AccessControlService();
  }

  async createEmployee(actor: Actor, input: CreateEmployeeInput): Promise<CreatedEmployee> {
    const login = canonicalizeLogin(input.login);
    const contactEmail = canonicalizeLogin(input.contactEmail);
    const fullName = input.fullName.trim();
    const reason = input.reason.trim();
    if (login === null || contactEmail === null || fullName === "" || reason === "") {
      throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 422, false, "Проверьте данные сотрудника.");
    }
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
        INSERT INTO crm.employees (id, full_name, email, contact_email, created_at, updated_at)
        VALUES (${employeeId}::uuid, ${fullName}::text, ${contactEmail}::text, ${contactEmail}::text, clock_timestamp(), clock_timestamp())
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
        INSERT INTO crm.login_claims (id, canonical_login, employment_epoch_id, state)
        VALUES (${createUuidV7()}::uuid, ${login}::text, ${employmentEpochId}::uuid, 'reserved')
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
          ${JSON.stringify({ subjectId, login, marker })}::jsonb
        )
      `);
      await writeSecurityAudit(transaction, { actorEmployeeId: actor.employeeId, action: "employee.provisioning.started", entityType: "employee", entityId: employeeId, reason, after: { employmentEpochId } });
      return { employeeId, employmentEpochId, subjectId, bindingId, marker, login };
    }));

    const password = temporaryPassword();
    const provisioned = await this.options.provider.createUser({ subjectId: reservation.subjectId, login: reservation.login, temporaryPassword: password, marker: reservation.marker });
    const exactIdentity = provisioned === "unavailable" ? "unavailable" : await this.options.provider.getUserById(reservation.subjectId);
    if (exactIdentity === "unavailable") {
      await this.markProvisionPending(reservation.employeeId, "provider_unavailable");
      throw new EmployeeServiceError("PROVISIONING_UNAVAILABLE", 503, true, "Учётная запись создаётся. Повторите проверку позже; пароль не был выдан.");
    }
    if (exactIdentity === null || exactIdentity.subjectId !== reservation.subjectId || exactIdentity.login !== reservation.login || exactIdentity.marker !== reservation.marker) {
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
        SET access_state = 'active', credential_state = 'temporary_password', provider_reconciled_at = clock_timestamp(),
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
        SET state = 'completed', completed_at = clock_timestamp()
        WHERE operation = 'provider_user_provision' AND aggregate_type = 'employment_epoch' AND aggregate_id = ${reservation.employmentEpochId}::uuid
      `);
      await writeSecurityAudit(transaction, { actorEmployeeId: actor.employeeId, action: "employee.provisioned", entityType: "employee", entityId: reservation.employeeId, reason, after: { employmentEpochId: reservation.employmentEpochId } });
    }));
    return { employeeId: reservation.employeeId, employmentEpochId: reservation.employmentEpochId, temporaryPassword: password };
  }

  /**
   * Private deployment operation, intentionally not registered as an HTTP
   * route. It may run once on an empty clinic and installs the first leader,
   * after which all employee management goes through normal RBAC commands.
   */
  async bootstrapInitialLeader(input: Omit<CreateEmployeeInput, "roleId">): Promise<CreatedEmployee> {
    const login = canonicalizeLogin(input.login);
    const contactEmail = canonicalizeLogin(input.contactEmail);
    const fullName = input.fullName.trim();
    const reason = input.reason.trim();
    if (login === null || contactEmail === null || fullName === "" || reason === "") {
      throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 422, false, "Проверьте данные первого руководителя.");
    }
    const reservation = await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
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
        INSERT INTO crm.employees (id, full_name, email, contact_email, created_at, updated_at)
        VALUES (${employeeId}::uuid, ${fullName}::text, ${contactEmail}::text, ${contactEmail}::text, clock_timestamp(), clock_timestamp())
      `);
      await transaction.execute(sql`INSERT INTO crm.employment_epochs (id, employee_id, sequence, state) VALUES (${employmentEpochId}::uuid, ${employeeId}::uuid, 1, 'provider_creating')`);
      await transaction.execute(sql`INSERT INTO crm.employee_security_states (employee_id, employment_epoch_id, access_state, credential_state) VALUES (${employeeId}::uuid, ${employmentEpochId}::uuid, 'suspended', 'unready')`);
      await transaction.execute(sql`INSERT INTO crm.login_claims (id, canonical_login, employment_epoch_id, state) VALUES (${createUuidV7()}::uuid, ${login}::text, ${employmentEpochId}::uuid, 'reserved')`);
      await transaction.execute(sql`INSERT INTO crm.auth_bindings (id, employment_epoch_id, provider_namespace, provider_subject_id, provider_marker, state) VALUES (${bindingId}::uuid, ${employmentEpochId}::uuid, ${this.options.providerNamespace}::text, ${subjectId}::uuid, ${marker}::text, 'reserved')`);
      await transaction.execute(sql`
        INSERT INTO crm.role_assignments (id, employee_id, employment_epoch_id, role_id, reason)
        VALUES (${createUuidV7()}::uuid, ${employeeId}::uuid, ${employmentEpochId}::uuid, '00000000-0000-7000-8000-000000000401'::uuid, ${reason}::text)
      `);
      return { employeeId, employmentEpochId, subjectId, bindingId, marker, login };
    }));
    const password = temporaryPassword();
    const provisioned = await this.options.provider.createUser({ subjectId: reservation.subjectId, login: reservation.login, temporaryPassword: password, marker: reservation.marker });
    const exactIdentity = provisioned === "unavailable" ? "unavailable" : await this.options.provider.getUserById(reservation.subjectId);
    if (exactIdentity === "unavailable") {
      await this.markProvisionPending(reservation.employeeId, "bootstrap_provider_unavailable");
      throw new EmployeeServiceError("PROVISIONING_UNAVAILABLE", 503, true, "Учётная запись руководителя создаётся. Временный пароль не был выдан.");
    }
    if (exactIdentity === null || exactIdentity.subjectId !== reservation.subjectId || exactIdentity.login !== reservation.login || exactIdentity.marker !== reservation.marker) {
      await this.failProvision(reservation.employeeId, reservation.employmentEpochId, "bootstrap_provider_identity_mismatch");
      throw new EmployeeServiceError("IDENTITY_RECONCILIATION_REQUIRED", 409, false, "Учётная запись руководителя требует проверки безопасности.");
    }
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await transaction.execute(sql`UPDATE crm.auth_bindings SET state = 'active', confirmed_at = clock_timestamp() WHERE id = ${reservation.bindingId}::uuid AND state = 'reserved'`);
      await transaction.execute(sql`UPDATE crm.login_claims SET state = 'active' WHERE employment_epoch_id = ${reservation.employmentEpochId}::uuid AND state = 'reserved'`);
      await transaction.execute(sql`UPDATE crm.employment_epochs SET state = 'active', started_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1 WHERE id = ${reservation.employmentEpochId}::uuid AND state = 'provider_creating'`);
      await transaction.execute(sql`UPDATE crm.employee_security_states SET access_state = 'active', credential_state = 'temporary_password', provider_reconciled_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1 WHERE employee_id = ${reservation.employeeId}::uuid`);
      await transaction.execute(sql`UPDATE crm.employees SET current_employment_epoch_id = ${reservation.employmentEpochId}::uuid, updated_at = clock_timestamp(), version = version + 1 WHERE id = ${reservation.employeeId}::uuid`);
      await transaction.execute(sql`
        INSERT INTO crm.clinic_security_states (id, security_initialized_at)
        VALUES (${createUuidV7()}::uuid, clock_timestamp())
        ON CONFLICT ((true)) DO UPDATE
        SET security_initialized_at = EXCLUDED.security_initialized_at, updated_at = clock_timestamp()
        WHERE crm.clinic_security_states.security_initialized_at IS NULL
      `);
      await writeSecurityAudit(transaction, { actorEmployeeId: null, action: "security.initial_leader.bootstrapped", entityType: "employee", entityId: reservation.employeeId, reason });
    }));
    return { employeeId: reservation.employeeId, employmentEpochId: reservation.employmentEpochId, temporaryPassword: password };
  }

  /** A rehire retains the person and historic authorship but creates a new immutable employment identity. */
  async rehireEmployee(actor: Actor, input: RehireEmployeeInput): Promise<CreatedEmployee> {
    const login = canonicalizeLogin(input.login);
    const contactEmail = canonicalizeLogin(input.contactEmail);
    const reason = input.reason.trim();
    if (login === null || contactEmail === null || reason === "") throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 422, false, "Проверьте данные повторного найма.");
    const reservation = await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      if (!(await this.accessControl.isLeader(transaction, actor))) {
        throw new AuthorizationError("SENSITIVE_PERMISSION_REQUIRED", "Только руководитель может повторно принять сотрудника.");
      }
      const former = await transaction.execute<{ employeeId: string; oldEpochId: string; accessState: string; employmentState: string }>(sql`
        SELECT security.employee_id AS "employeeId", security.employment_epoch_id AS "oldEpochId", security.access_state AS "accessState", epoch.state AS "employmentState"
        FROM crm.employee_security_states AS security
        JOIN crm.employment_epochs AS epoch ON epoch.id = security.employment_epoch_id
        WHERE security.employee_id = ${input.employeeId}::uuid
        LIMIT 1
        FOR UPDATE OF security, epoch
      `);
      const employee = former.rows[0];
      if (employee === undefined || employee.accessState !== "terminated" || employee.employmentState !== "terminated") {
        throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 409, false, "Повторный найм возможен только для уволенного сотрудника.");
      }
      const existingLogin = await transaction.execute<{ id: string }>(sql`SELECT id FROM crm.login_claims WHERE canonical_login = ${login}::text LIMIT 1 FOR UPDATE`);
      if (existingLogin.rows[0] !== undefined) throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 409, false, "Логин уже зарезервирован в истории и не может быть использован повторно.");
      const role = await transaction.execute<{ id: string }>(sql`SELECT id FROM crm.roles WHERE id = ${input.roleId}::uuid AND archived_at IS NULL LIMIT 1`);
      if (role.rows[0] === undefined) throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 422, false, "Выбранная роль недоступна.");
      const sequenceResult = await transaction.execute<{ sequence: number }>(sql`SELECT COALESCE(max(sequence), 0) AS sequence FROM crm.employment_epochs WHERE employee_id = ${input.employeeId}::uuid`);
      const employmentEpochId = createUuidV7();
      const subjectId = createUuidV7();
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
      await transaction.execute(sql`INSERT INTO crm.login_claims (id, canonical_login, employment_epoch_id, state) VALUES (${createUuidV7()}::uuid, ${login}::text, ${employmentEpochId}::uuid, 'reserved')`);
      await transaction.execute(sql`INSERT INTO crm.auth_bindings (id, employment_epoch_id, provider_namespace, provider_subject_id, provider_marker, state) VALUES (${bindingId}::uuid, ${employmentEpochId}::uuid, ${this.options.providerNamespace}::text, ${subjectId}::uuid, ${marker}::text, 'reserved')`);
      await transaction.execute(sql`INSERT INTO crm.role_assignments (id, employee_id, employment_epoch_id, role_id, assigned_by_employee_id, reason) VALUES (${createUuidV7()}::uuid, ${input.employeeId}::uuid, ${employmentEpochId}::uuid, ${input.roleId}::uuid, ${actor.employeeId}::uuid, ${reason}::text)`);
      await transaction.execute(sql`INSERT INTO crm.security_outbox (id, operation, aggregate_type, aggregate_id, expected_epoch, payload) VALUES (${createUuidV7()}::uuid, 'provider_user_provision', 'employment_epoch', ${employmentEpochId}::uuid, 1, ${JSON.stringify({ subjectId, login, marker })}::jsonb)`);
      return { employeeId: input.employeeId, employmentEpochId, subjectId, bindingId, marker, login };
    }));
    const password = temporaryPassword();
    const provisioned = await this.options.provider.createUser({ subjectId: reservation.subjectId, login: reservation.login, temporaryPassword: password, marker: reservation.marker });
    const exactIdentity = provisioned === "unavailable" ? "unavailable" : await this.options.provider.getUserById(reservation.subjectId);
    if (exactIdentity === "unavailable") {
      await this.markProvisionPending(reservation.employeeId, "rehire_provider_unavailable");
      throw new EmployeeServiceError("PROVISIONING_UNAVAILABLE", 503, true, "Учётная запись создаётся. Временный пароль не был выдан.");
    }
    if (exactIdentity === null || exactIdentity.subjectId !== reservation.subjectId || exactIdentity.login !== reservation.login || exactIdentity.marker !== reservation.marker) {
      await this.failProvision(reservation.employeeId, reservation.employmentEpochId, "rehire_provider_identity_mismatch");
      throw new EmployeeServiceError("IDENTITY_RECONCILIATION_REQUIRED", 409, false, "Учётная запись требует проверки безопасности.");
    }
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await transaction.execute(sql`UPDATE crm.auth_bindings SET state = 'active', confirmed_at = clock_timestamp() WHERE id = ${reservation.bindingId}::uuid AND state = 'reserved'`);
      await transaction.execute(sql`UPDATE crm.login_claims SET state = 'active' WHERE employment_epoch_id = ${reservation.employmentEpochId}::uuid AND state = 'reserved'`);
      await transaction.execute(sql`UPDATE crm.employment_epochs SET state = 'active', started_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1 WHERE id = ${reservation.employmentEpochId}::uuid AND state = 'provider_creating'`);
      await transaction.execute(sql`UPDATE crm.employee_security_states SET access_state = 'active', credential_state = 'temporary_password', provider_reconciled_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1 WHERE employee_id = ${reservation.employeeId}::uuid AND employment_epoch_id = ${reservation.employmentEpochId}::uuid`);
      await transaction.execute(sql`UPDATE crm.employees SET contact_email = ${contactEmail}::text, email = ${contactEmail}::text, current_employment_epoch_id = ${reservation.employmentEpochId}::uuid, updated_at = clock_timestamp(), version = version + 1 WHERE id = ${reservation.employeeId}::uuid`);
      await transaction.execute(sql`UPDATE crm.security_outbox SET state = 'completed', completed_at = clock_timestamp() WHERE operation = 'provider_user_provision' AND aggregate_type = 'employment_epoch' AND aggregate_id = ${reservation.employmentEpochId}::uuid`);
      await writeSecurityAudit(transaction, { actorEmployeeId: actor.employeeId, action: "employee.rehired", entityType: "employee", entityId: reservation.employeeId, reason, after: { employmentEpochId: reservation.employmentEpochId } });
    }));
    return { employeeId: reservation.employeeId, employmentEpochId: reservation.employmentEpochId, temporaryPassword: password };
  }

  async unlockAccount(actor: Actor, employeeId: string, reason: string): Promise<void> {
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
    if (reason.trim() === "") throw new EmployeeServiceError("EMPLOYEE_CONFLICT", 422, false, "Укажите причину сброса пароля.");
    const target = await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await this.accessControl.requirePermission(transaction, actor, "employees.manage", "all");
      const result = await transaction.execute<{ employeeId: string; employmentEpochId: string; providerSubjectId: string }>(sql`
        SELECT security.employee_id AS "employeeId", security.employment_epoch_id AS "employmentEpochId", binding.provider_subject_id AS "providerSubjectId"
        FROM crm.employee_security_states AS security
        JOIN crm.employment_epochs AS epoch ON epoch.id = security.employment_epoch_id
        JOIN crm.auth_bindings AS binding ON binding.employment_epoch_id = epoch.id AND binding.state = 'active'
        WHERE security.employee_id = ${employeeId}::uuid
          AND security.access_state = 'active'
          AND epoch.state = 'active'
          AND security.credential_state IN ('temporary_password', 'ready', 'password_change_required')
        LIMIT 1
        FOR UPDATE OF security, epoch, binding
      `);
      const identity = result.rows[0];
      if (identity === undefined) throw new EmployeeServiceError("EMPLOYEE_NOT_FOUND", 404, false, "Активный сотрудник не найден.");
      await transaction.execute(sql`
        UPDATE crm.employee_security_states
        SET credential_state = 'changing', session_epoch = session_epoch + 1,
            updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${employeeId}::uuid
      `);
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
          SET credential_state = 'reconciliation_required', updated_at = clock_timestamp(), version = version + 1
          WHERE employee_id = ${employeeId}::uuid
        `);
        await writeSecurityAudit(transaction, { actorEmployeeId: actor.employeeId, action: "employee.password.reset_reconciliation_required", entityType: "employee", entityId: employeeId, reason: "provider_update_ambiguous" });
      }));
      throw new EmployeeServiceError("PROVISIONING_UNAVAILABLE", 503, true, "Сброс требует проверки безопасности. Временный пароль не был выдан.");
    }
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE crm.employee_security_states
        SET credential_state = 'temporary_password', credential_epoch = credential_epoch + 1,
            login_failure_count = 0, login_locked_until = NULL, updated_at = clock_timestamp(), version = version + 1
        WHERE employee_id = ${employeeId}::uuid AND employment_epoch_id = ${target.employmentEpochId}::uuid
      `);
      await writeSecurityAudit(transaction, { actorEmployeeId: actor.employeeId, action: "employee.password.temporary_issued", entityType: "employee", entityId: employeeId, reason: reason.trim() });
    }));
    return { temporaryPassword: password };
  }

  async offboardEmployee(actor: Actor, input: OffboardEmployeeInput): Promise<void> {
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
      if (input.medicalCaseReplacementEmployeeId !== undefined) {
        await transaction.execute(sql`
          UPDATE crm.medical_cases SET responsible_employee_id = ${input.medicalCaseReplacementEmployeeId}::uuid, updated_at = clock_timestamp(), version = version + 1
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
        SET access_state = 'terminated', credential_state = 'disabled', session_epoch = session_epoch + 1,
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
        VALUES (${createUuidV7()}::uuid, 'provider_user_ban', 'employee', ${input.employeeId}::uuid, NULL, '{}'::jsonb)
        ON CONFLICT (operation, aggregate_type, aggregate_id) DO NOTHING
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

  private async markProvisionPending(employeeId: string, reason: string): Promise<void> {
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE crm.security_outbox
        SET state = 'pending', attempts = attempts + 1, next_attempt_at = clock_timestamp() + interval '5 minutes'
        WHERE aggregate_type = 'employment_epoch'
          AND operation = 'provider_user_provision'
          AND aggregate_id = (SELECT employment_epoch_id FROM crm.employee_security_states WHERE employee_id = ${employeeId}::uuid)
      `);
      await writeSecurityAudit(transaction, { actorEmployeeId: null, action: "employee.provisioning.pending", entityType: "employee", entityId: employeeId, reason });
    }));
  }

  private async failProvision(employeeId: string, employmentEpochId: string, reason: string): Promise<void> {
    await this.options.withDatabase(async (database) => database.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE crm.employee_security_states
        SET access_state = 'security_quarantined', credential_state = 'reconciliation_required',
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
