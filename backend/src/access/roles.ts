import { sql } from "drizzle-orm";

import { AccessControlService, AuthorizationError, parseRecordScope } from "./control";
import { hashSecret } from "../auth/crypto";
import type { RequestDatabase } from "../db/integrity";
import { createUuidV7 } from "../db/uuidv7";

type DatabaseRunner = <T>(callback: (database: RequestDatabase) => Promise<T>) => Promise<T>;
type Actor = { employeeId: string; employmentEpochId: string };

export type RoleGrantInput = { permissionCode: string; scope: unknown };

export class RoleServiceError extends Error {
  constructor(
    readonly code: "ROLE_NOT_FOUND" | "ROLE_ASSIGNMENT_NOT_FOUND" | "ROLE_CONFLICT" | "EMPLOYEE_NOT_FOUND" | "INVALID_PERMISSION_SCOPE",
    readonly status: 404 | 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = "RoleServiceError";
  }
}

async function writeAudit(database: RequestDatabase, actor: Actor, action: string, entityType: string, entityId: string, reason: string, after?: Record<string, unknown>): Promise<void> {
  await database.execute(sql`
    INSERT INTO crm.audit_entries (id, actor_employee_id, action, category, view_scope, entity_type, entity_id, reason, after)
    VALUES (
      ${createUuidV7()}::uuid, ${actor.employeeId}::uuid, ${action}::text,
      'security'::text, 'roles'::text, ${entityType}::text, ${entityId}::uuid,
      ${reason}::text, ${after === undefined ? null : JSON.stringify(after)}::jsonb
    )
  `);
}

async function activeTarget(database: RequestDatabase, employeeId: string): Promise<{ employmentEpochId: string } | null> {
  const result = await database.execute<{ employmentEpochId: string }>(sql`
    SELECT security.employment_epoch_id AS "employmentEpochId"
    FROM crm.employee_security_states AS security
    JOIN crm.employment_epochs AS epoch ON epoch.id = security.employment_epoch_id
    WHERE security.employee_id = ${employeeId}::uuid
      AND security.access_state = 'active'
      AND epoch.state = 'active'
    LIMIT 1
  `);
  return result.rows[0] ?? null;
}

export class RoleService {
  private readonly accessControl = new AccessControlService();

  constructor(private readonly withDatabase: DatabaseRunner) {}

  async assignRole(actor: Actor, input: { employeeId: string; roleId: string; reason: string }): Promise<void> {
    if (input.reason.trim() === "") throw new RoleServiceError("ROLE_CONFLICT", 422, "Укажите причину назначения роли.");
    await this.withDatabase(async (database) => database.transaction(async (transaction) => {
      await this.accessControl.assertRoleAssignmentAllowed(transaction, actor, input.employeeId, input.roleId);
      const target = await activeTarget(transaction, input.employeeId);
      if (target === null) throw new RoleServiceError("EMPLOYEE_NOT_FOUND", 404, "Активный сотрудник не найден.");
      const inserted = await transaction.execute<{ id: string }>(sql`
        INSERT INTO crm.role_assignments (id, employee_id, employment_epoch_id, role_id, assigned_by_employee_id, reason)
        VALUES (${createUuidV7()}::uuid, ${input.employeeId}::uuid, ${target.employmentEpochId}::uuid, ${input.roleId}::uuid, ${actor.employeeId}::uuid, ${input.reason.trim()}::text)
        ON CONFLICT (employment_epoch_id, role_id) WHERE revoked_at IS NULL DO NOTHING
        RETURNING id
      `);
      if (inserted.rows[0] === undefined) throw new RoleServiceError("ROLE_CONFLICT", 409, "Эта роль уже назначена сотруднику.");
      await writeAudit(transaction, actor, "employee.role.assigned", "roleAssignment", inserted.rows[0].id, input.reason.trim(), { employeeId: input.employeeId, roleId: input.roleId });
    }));
  }

  async revokeRole(actor: Actor, input: { employeeId: string; roleId: string; reason: string }): Promise<void> {
    if (actor.employeeId === input.employeeId) throw new AuthorizationError("SELF_ESCALATION_DENIED", "Нельзя изменять собственные роли или права.");
    if (input.reason.trim() === "") throw new RoleServiceError("ROLE_CONFLICT", 422, "Укажите причину отзыва роли.");
    await this.withDatabase(async (database) => database.transaction(async (transaction) => {
      await this.accessControl.requirePermission(transaction, actor, "roles.assign", "all");
      const assignment = await transaction.execute<{ id: string; systemKind: string }>(sql`
        SELECT assignment.id, role.system_kind AS "systemKind"
        FROM crm.role_assignments AS assignment
        JOIN crm.roles AS role ON role.id = assignment.role_id
        WHERE assignment.employee_id = ${input.employeeId}::uuid
          AND assignment.role_id = ${input.roleId}::uuid
          AND assignment.revoked_at IS NULL
        LIMIT 1
        FOR UPDATE OF assignment, role
      `);
      const current = assignment.rows[0];
      if (current === undefined) throw new RoleServiceError("ROLE_ASSIGNMENT_NOT_FOUND", 404, "Активное назначение роли не найдено.");
      if (current.systemKind === "leader" && !(await this.accessControl.isLeader(transaction, actor))) {
        throw new AuthorizationError("ROLE_ASSIGNMENT_DENIED", "Только руководитель может менять роль руководителя.");
      }
      await transaction.execute(sql`
        UPDATE crm.role_assignments
        SET revoked_at = clock_timestamp(), version = version + 1
        WHERE id = ${current.id}::uuid AND revoked_at IS NULL
      `);
      await writeAudit(transaction, actor, "employee.role.revoked", "roleAssignment", current.id, input.reason.trim(), { employeeId: input.employeeId, roleId: input.roleId });
    }));
  }

  async setEmployeePermissionOverride(actor: Actor, input: { employeeId: string; permissionCode: string; mode: "replace" | "deny"; scope?: unknown; reason: string }): Promise<void> {
    if (actor.employeeId === input.employeeId) throw new AuthorizationError("SELF_ESCALATION_DENIED", "Нельзя изменять собственные роли или права.");
    if (input.reason.trim() === "" || (input.mode === "replace" && parseRecordScope(input.scope) === null) || (input.mode === "deny" && input.scope !== undefined)) {
      throw new RoleServiceError("INVALID_PERMISSION_SCOPE", 422, "Некорректное индивидуальное исключение.");
    }
    await this.withDatabase(async (database) => database.transaction(async (transaction) => {
      // Individual exceptions always affect privileges, therefore are leader-only.
      if (!(await this.accessControl.isLeader(transaction, actor))) {
        throw new AuthorizationError("SENSITIVE_PERMISSION_REQUIRED", "Только руководитель может менять индивидуальные права.");
      }
      const catalog = await transaction.execute<{ code: string }>(sql`
        SELECT code FROM crm.permission_catalog WHERE code = ${input.permissionCode}::text LIMIT 1
      `);
      if (catalog.rows[0] === undefined) throw new RoleServiceError("INVALID_PERMISSION_SCOPE", 422, "Неизвестное разрешение.");
      const target = await activeTarget(transaction, input.employeeId);
      if (target === null) throw new RoleServiceError("EMPLOYEE_NOT_FOUND", 404, "Активный сотрудник не найден.");
      const existing = await transaction.execute<{ id: string }>(sql`
        SELECT id
        FROM crm.employee_permission_overrides
        WHERE employment_epoch_id = ${target.employmentEpochId}::uuid
          AND permission_code = ${input.permissionCode}::text
          AND revoked_at IS NULL
        LIMIT 1
        FOR UPDATE
      `);
      const id = existing.rows[0]?.id ?? createUuidV7();
      if (existing.rows[0] === undefined) {
        await transaction.execute(sql`
          INSERT INTO crm.employee_permission_overrides (
            id, employee_id, employment_epoch_id, permission_code, mode, scope, granted_by_employee_id, reason
          ) VALUES (
            ${id}::uuid, ${input.employeeId}::uuid, ${target.employmentEpochId}::uuid,
            ${input.permissionCode}::text, ${input.mode}::text,
            ${input.mode === "deny" ? null : JSON.stringify(input.scope)}::jsonb,
            ${actor.employeeId}::uuid, ${input.reason.trim()}::text
          )
        `);
      } else {
        await transaction.execute(sql`
          UPDATE crm.employee_permission_overrides
          SET mode = ${input.mode}::text,
              scope = ${input.mode === "deny" ? null : JSON.stringify(input.scope)}::jsonb,
              granted_by_employee_id = ${actor.employeeId}::uuid,
              reason = ${input.reason.trim()}::text,
              version = version + 1
          WHERE id = ${id}::uuid
        `);
      }
      await writeAudit(transaction, actor, "employee.permission.override_set", "employeePermissionOverride", id, input.reason.trim(), { employeeId: input.employeeId, permissionCode: input.permissionCode, mode: input.mode });
    }));
  }

  async publishRoleRevision(actor: Actor, input: { roleId: string; expectedVersion: number; grants: readonly RoleGrantInput[]; reason: string }): Promise<void> {
    if (input.reason.trim() === "" || input.grants.length === 0 || input.grants.some((grant) => grant.permissionCode.trim() === "" || parseRecordScope(grant.scope) === null)) {
      throw new RoleServiceError("INVALID_PERMISSION_SCOPE", 422, "Некорректный состав разрешений роли.");
    }
    const duplicates = new Set<string>();
    if (input.grants.some((grant) => duplicates.has(grant.permissionCode) || (duplicates.add(grant.permissionCode), false))) {
      throw new RoleServiceError("INVALID_PERMISSION_SCOPE", 422, "Разрешение не может повторяться в редакции роли.");
    }
    await this.withDatabase(async (database) => database.transaction(async (transaction) => {
      if (!(await this.accessControl.isLeader(transaction, actor))) {
        throw new AuthorizationError("SENSITIVE_PERMISSION_REQUIRED", "Только руководитель может менять состав ролей.");
      }
      const role = await transaction.execute<{ id: string; version: number; revision: number }>(sql`
        SELECT role.id, role.version, COALESCE(current.revision, 0) AS revision
        FROM crm.roles AS role
        LEFT JOIN crm.role_revisions AS current ON current.id = role.current_revision_id
        WHERE role.id = ${input.roleId}::uuid AND role.archived_at IS NULL
        LIMIT 1
        FOR UPDATE OF role
      `);
      const current = role.rows[0];
      if (current === undefined) throw new RoleServiceError("ROLE_NOT_FOUND", 404, "Роль не найдена.");
      if (current.version !== input.expectedVersion) throw new RoleServiceError("ROLE_CONFLICT", 409, "Роль уже изменилась. Обновите данные.");
      const catalog = await transaction.execute<{ code: string }>(sql`
        SELECT code FROM crm.permission_catalog WHERE code = ANY(${input.grants.map((grant) => grant.permissionCode)}::text[])
      `);
      if (catalog.rows.length !== input.grants.length) throw new RoleServiceError("INVALID_PERMISSION_SCOPE", 422, "Роль содержит неизвестное разрешение.");
      const revisionId = createUuidV7();
      const canonicalGrants = [...input.grants]
        .map((grant) => ({ permissionCode: grant.permissionCode, scope: grant.scope }))
        .sort((left, right) => left.permissionCode.localeCompare(right.permissionCode));
      await transaction.execute(sql`
        INSERT INTO crm.role_revisions (id, role_id, revision, published_by_employee_id, reason, capability_hash)
        VALUES (
          ${revisionId}::uuid, ${input.roleId}::uuid, ${current.revision + 1}::integer,
          ${actor.employeeId}::uuid, ${input.reason.trim()}::text,
          ${await hashSecret(JSON.stringify(canonicalGrants))}::text
        )
      `);
      for (const grant of canonicalGrants) {
        await transaction.execute(sql`
          INSERT INTO crm.role_grants (id, role_revision_id, permission_code, scope)
          VALUES (${createUuidV7()}::uuid, ${revisionId}::uuid, ${grant.permissionCode}::text, ${JSON.stringify(grant.scope)}::jsonb)
        `);
      }
      await transaction.execute(sql`
        UPDATE crm.roles
        SET current_revision_id = ${revisionId}::uuid, authorization_revision = authorization_revision + 1,
            updated_at = clock_timestamp(), version = version + 1
        WHERE id = ${input.roleId}::uuid AND version = ${input.expectedVersion}::integer
      `);
      await writeAudit(transaction, actor, "role.revision.published", "role", input.roleId, input.reason.trim(), { revisionId, permissionCount: canonicalGrants.length });
    }));
  }
}
