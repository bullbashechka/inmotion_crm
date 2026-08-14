import { sql } from "drizzle-orm";

import type { RequestDatabase } from "../db/integrity";

export type RecordScope = "own" | "assigned" | "all";

export type RoleGrant = { permissionCode: string; scope: unknown };
export type PermissionOverride = { permissionCode: string; mode: "replace" | "deny"; scope: unknown };
export type EffectivePermissions = ReadonlyMap<string, RecordScope>;

type PermissionRow = { permissionCode: string; scope: unknown };
type OverrideRow = { permissionCode: string; mode: "replace" | "deny"; scope: unknown };
type CatalogRow = { isSensitive: number; isGovernance: number };

const scopeRank: Record<RecordScope, number> = { own: 1, assigned: 2, all: 3 };

export class AuthorizationError extends Error {
  constructor(
    readonly code: "PERMISSION_DENIED" | "SENSITIVE_PERMISSION_REQUIRED" | "ROLE_ASSIGNMENT_DENIED" | "SELF_ESCALATION_DENIED",
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function parseRecordScope(scope: unknown): RecordScope | null {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope) || !("records" in scope)) return null;
  const records = scope.records;
  return records === "own" || records === "assigned" || records === "all" ? records : null;
}

/**
 * Role grants compose by the widest allowed scope. An employee override is
 * authoritative: DENY removes the permission and REPLACE discards role grants.
 */
export function resolveEffectivePermissions(roleGrants: readonly RoleGrant[], overrides: readonly PermissionOverride[]): EffectivePermissions {
  const effective = new Map<string, RecordScope>();
  for (const grant of roleGrants) {
    const scope = parseRecordScope(grant.scope);
    if (scope === null) continue; // malformed persisted scope must never grant access
    const previous = effective.get(grant.permissionCode);
    if (previous === undefined || scopeRank[scope] > scopeRank[previous]) effective.set(grant.permissionCode, scope);
  }
  for (const override of overrides) {
    if (override.mode === "deny") {
      effective.delete(override.permissionCode);
      continue;
    }
    const scope = parseRecordScope(override.scope);
    if (scope === null) {
      effective.delete(override.permissionCode);
      continue;
    }
    effective.set(override.permissionCode, scope);
  }
  return effective;
}

export function includesScope(granted: RecordScope, requested: RecordScope): boolean {
  return scopeRank[granted] >= scopeRank[requested];
}

export class AccessControlService {
  async effectivePermissions(database: RequestDatabase, actor: { employeeId: string; employmentEpochId: string }): Promise<EffectivePermissions> {
    const [roleResult, overrideResult] = await Promise.all([
      database.execute<PermissionRow>(sql`
        SELECT grant.permission_code AS "permissionCode", grant.scope
        FROM crm.role_assignments AS assignment
        JOIN crm.roles AS role
          ON role.id = assignment.role_id
         AND role.archived_at IS NULL
        JOIN crm.role_grants AS grant
          ON grant.role_revision_id = role.current_revision_id
        WHERE assignment.employee_id = ${actor.employeeId}::uuid
          AND assignment.employment_epoch_id = ${actor.employmentEpochId}::uuid
          AND assignment.revoked_at IS NULL
      `),
      database.execute<OverrideRow>(sql`
        SELECT permission_code AS "permissionCode", mode, scope
        FROM crm.employee_permission_overrides
        WHERE employee_id = ${actor.employeeId}::uuid
          AND employment_epoch_id = ${actor.employmentEpochId}::uuid
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > clock_timestamp())
      `),
    ]);
    return resolveEffectivePermissions(roleResult.rows, overrideResult.rows);
  }

  async requirePermission(
    database: RequestDatabase,
    actor: { employeeId: string; employmentEpochId: string },
    permissionCode: string,
    requestedScope: RecordScope = "own",
  ): Promise<EffectivePermissions> {
    const effective = await this.effectivePermissions(database, actor);
    const scope = effective.get(permissionCode);
    if (scope === undefined || !includesScope(scope, requestedScope)) {
      throw new AuthorizationError("PERMISSION_DENIED", "Недостаточно прав для этого действия.");
    }
    return effective;
  }

  async requireSensitivePermission(
    database: RequestDatabase,
    actor: { employeeId: string; employmentEpochId: string },
    permissionCode: string,
  ): Promise<void> {
    const [catalog, effective] = await Promise.all([
      database.execute<CatalogRow>(sql`
        SELECT is_sensitive AS "isSensitive", is_governance AS "isGovernance"
        FROM crm.permission_catalog
        WHERE code = ${permissionCode}::text
        LIMIT 1
      `),
      this.effectivePermissions(database, actor),
    ]);
    const definition = catalog.rows[0];
    if (definition === undefined || (definition.isSensitive !== 1 && definition.isGovernance !== 1) || !effective.has(permissionCode)) {
      throw new AuthorizationError("SENSITIVE_PERMISSION_REQUIRED", "Только руководитель может предоставить или изменить это разрешение.");
    }
    const leader = await database.execute<{ hasLeaderRole: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM crm.role_assignments AS assignment
        JOIN crm.roles AS role ON role.id = assignment.role_id
        WHERE assignment.employee_id = ${actor.employeeId}::uuid
          AND assignment.employment_epoch_id = ${actor.employmentEpochId}::uuid
          AND assignment.revoked_at IS NULL
          AND role.system_kind = 'leader'
          AND role.archived_at IS NULL
      ) AS "hasLeaderRole"
    `);
    if (leader.rows[0]?.hasLeaderRole !== true) {
      throw new AuthorizationError("SENSITIVE_PERMISSION_REQUIRED", "Только руководитель может предоставить или изменить это разрешение.");
    }
  }

  async assertRoleAssignmentAllowed(
    database: RequestDatabase,
    actor: { employeeId: string; employmentEpochId: string },
    targetEmployeeId: string,
    roleId: string,
  ): Promise<void> {
    if (actor.employeeId === targetEmployeeId) {
      throw new AuthorizationError("SELF_ESCALATION_DENIED", "Нельзя изменять собственные роли или права.");
    }
    await this.requirePermission(database, actor, "roles.assign", "all");
    const role = await database.execute<{ systemKind: string; adminAssignable: number }>(sql`
      SELECT system_kind AS "systemKind", admin_assignable AS "adminAssignable"
      FROM crm.roles
      WHERE id = ${roleId}::uuid AND archived_at IS NULL
      LIMIT 1
    `);
    const targetRole = role.rows[0];
    if (targetRole === undefined) throw new AuthorizationError("ROLE_ASSIGNMENT_DENIED", "Роль недоступна для назначения.");
    const actorIsLeader = await this.isLeader(database, actor);
    if (!actorIsLeader && (targetRole.adminAssignable !== 1 || targetRole.systemKind === "leader")) {
      throw new AuthorizationError("ROLE_ASSIGNMENT_DENIED", "Администратор может назначать только готовые не-руководящие роли.");
    }
  }

  async isLeader(database: RequestDatabase, actor: { employeeId: string; employmentEpochId: string }): Promise<boolean> {
    const result = await database.execute<{ leader: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM crm.role_assignments AS assignment
        JOIN crm.roles AS role ON role.id = assignment.role_id
        WHERE assignment.employee_id = ${actor.employeeId}::uuid
          AND assignment.employment_epoch_id = ${actor.employmentEpochId}::uuid
          AND assignment.revoked_at IS NULL
          AND role.system_kind = 'leader'
          AND role.archived_at IS NULL
      ) AS leader
    `);
    return result.rows[0]?.leader === true;
  }
}
