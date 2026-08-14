import { relations, sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const crm = pgSchema("crm");

const lifecycleColumns = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  version: integer("version").notNull().default(1),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
};

const nonBlank = (column: { name: string }) => sql`btrim(${column}) <> ''`;
const positiveVersion = (column: { name: string }) => sql`${column} > 0`;
const active = (column: { name: string }) => sql`${column} IS NULL`;

export const clinicSettings = crm.table("clinic_settings", {
  id: uuid("id").primaryKey(),
  clinicName: text("clinic_name").notNull(),
  timezone: text("timezone").notNull(),
  ...lifecycleColumns,
}, (table) => [
  uniqueIndex("clinic_settings_one_active_unique").on(sql`(true)`).where(active(table.archivedAt)),
  check("clinic_settings_clinic_name_not_blank", nonBlank(table.clinicName)),
  check("clinic_settings_timezone_not_blank", nonBlank(table.timezone)),
  check("clinic_settings_version_positive", positiveVersion(table.version)),
]);

export const employees = crm.table("employees", {
  id: uuid("id").primaryKey(),
  /** Legacy current binding retained during task-004 expand/contract migration. */
  authSubjectId: uuid("auth_subject_id"),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  contactEmail: text("contact_email"),
  currentEmploymentEpochId: uuid("current_employment_epoch_id").references(() => employmentEpochs.id, { onDelete: "restrict" }),
  ...lifecycleColumns,
}, (table) => [
  unique("employees_auth_subject_unique").on(table.authSubjectId),
  uniqueIndex("employees_email_unique").on(sql`lower(${table.email})`),
  check("employees_full_name_not_blank", nonBlank(table.fullName)),
  check("employees_email_not_blank", nonBlank(table.email)),
  check("employees_version_positive", positiveVersion(table.version)),
]);

export const clinicSecurityStates = crm.table("clinic_security_states", {
  id: uuid("id").primaryKey(),
  securityInitializedAt: timestamp("security_initialized_at", { withTimezone: true, mode: "date" }),
  authorizationRevision: integer("authorization_revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("clinic_security_states_one_current_unique").on(sql`(true)`),
  check("clinic_security_states_revision_positive", positiveVersion(table.authorizationRevision)),
]);

export const employmentEpochs = crm.table("employment_epochs", {
  id: uuid("id").primaryKey(),
  employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(),
  state: text("state").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  version: integer("version").notNull().default(1),
}, (table) => [
  unique("employment_epochs_employee_sequence_unique").on(table.employeeId, table.sequence),
  uniqueIndex("employment_epochs_one_current_per_employee_unique")
    .on(table.employeeId)
    .where(sql`${table.state} IN ('reserved', 'provider_creating', 'provider_confirmed', 'activating', 'active', 'offboarding')`),
  index("employment_epochs_employee_state_idx").on(table.employeeId, table.state),
  check("employment_epochs_state_valid", sql`${table.state} IN ('reserved', 'provider_creating', 'provider_confirmed', 'activating', 'active', 'offboarding', 'terminated', 'failed', 'cancelled', 'quarantined')`),
  check("employment_epochs_sequence_positive", sql`${table.sequence} > 0`),
  check("employment_epochs_version_positive", positiveVersion(table.version)),
  check("employment_epochs_interval_valid", sql`${table.endedAt} IS NULL OR ${table.startedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}`),
]);

export const employeeSecurityStates = crm.table("employee_security_states", {
  employeeId: uuid("employee_id").primaryKey().references(() => employees.id, { onDelete: "restrict" }),
  employmentEpochId: uuid("employment_epoch_id").references(() => employmentEpochs.id, { onDelete: "restrict" }),
  accessState: text("access_state").notNull().default("suspended"),
  credentialState: text("credential_state").notNull().default("unready"),
  loginFailureCount: integer("login_failure_count").notNull().default(0),
  loginLockedUntil: timestamp("login_locked_until", { withTimezone: true, mode: "date" }),
  sessionEpoch: integer("session_epoch").notNull().default(1),
  credentialEpoch: integer("credential_epoch").notNull().default(1),
  authorizationRevision: integer("authorization_revision").notNull().default(1),
  providerReconciledAt: timestamp("provider_reconciled_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  version: integer("version").notNull().default(1),
}, (table) => [
  uniqueIndex("employee_security_states_epoch_unique")
    .on(table.employmentEpochId)
    .where(sql`${table.employmentEpochId} IS NOT NULL`),
  check("employee_security_states_access_valid", sql`${table.accessState} IN ('active', 'suspended', 'security_quarantined', 'terminated')`),
  check("employee_security_states_credential_valid", sql`${table.credentialState} IN ('unready', 'temporary_password', 'ready', 'password_change_required', 'changing', 'reconciliation_required', 'disabled')`),
  check("employee_security_states_failure_count_valid", sql`${table.loginFailureCount} BETWEEN 0 AND 5`),
  check("employee_security_states_session_epoch_positive", sql`${table.sessionEpoch} > 0`),
  check("employee_security_states_credential_epoch_positive", sql`${table.credentialEpoch} > 0`),
  check("employee_security_states_authorization_revision_positive", positiveVersion(table.authorizationRevision)),
  check("employee_security_states_version_positive", positiveVersion(table.version)),
]);

export const loginClaims = crm.table("login_claims", {
  id: uuid("id").primaryKey(),
  canonicalLogin: text("canonical_login").notNull(),
  employmentEpochId: uuid("employment_epoch_id").references(() => employmentEpochs.id, { onDelete: "restrict" }),
  state: text("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  unique("login_claims_canonical_login_unique").on(table.canonicalLogin),
  check("login_claims_canonical_login_not_blank", nonBlank(table.canonicalLogin)),
  check("login_claims_state_valid", sql`${table.state} IN ('reserved', 'active', 'tombstoned', 'cancelled')`),
]);

export const authBindings = crm.table("auth_bindings", {
  id: uuid("id").primaryKey(),
  employmentEpochId: uuid("employment_epoch_id").notNull().references(() => employmentEpochs.id, { onDelete: "restrict" }),
  providerNamespace: text("provider_namespace").notNull(),
  providerSubjectId: uuid("provider_subject_id").notNull(),
  providerMarker: text("provider_marker").notNull(),
  state: text("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  unique("auth_bindings_provider_subject_unique").on(table.providerNamespace, table.providerSubjectId),
  uniqueIndex("auth_bindings_one_current_epoch_unique")
    .on(table.employmentEpochId)
    .where(sql`${table.state} IN ('reserved', 'confirmed', 'active')`),
  check("auth_bindings_namespace_not_blank", nonBlank(table.providerNamespace)),
  check("auth_bindings_marker_not_blank", nonBlank(table.providerMarker)),
  check("auth_bindings_state_valid", sql`${table.state} IN ('reserved', 'confirmed', 'active', 'ended', 'quarantined')`),
]);

export const permissionCatalog = crm.table("permission_catalog", {
  code: text("code").primaryKey(),
  resourceFamily: text("resource_family").notNull(),
  isSensitive: integer("is_sensitive").notNull().default(0),
  isGovernance: integer("is_governance").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  check("permission_catalog_code_not_blank", nonBlank(table.code)),
  check("permission_catalog_family_not_blank", nonBlank(table.resourceFamily)),
  check("permission_catalog_sensitive_bool", sql`${table.isSensitive} IN (0, 1)`),
  check("permission_catalog_governance_bool", sql`${table.isGovernance} IN (0, 1)`),
]);

export const roles = crm.table("roles", {
  id: uuid("id").primaryKey(),
  code: text("code").notNull(),
  systemKind: text("system_kind").notNull().default("custom"),
  currentRevisionId: uuid("current_revision_id").references(() => roleRevisions.id, { onDelete: "restrict" }),
  adminAssignable: integer("admin_assignable").notNull().default(0),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
  authorizationRevision: integer("authorization_revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  version: integer("version").notNull().default(1),
}, (table) => [
  unique("roles_code_unique").on(table.code),
  check("roles_code_not_blank", nonBlank(table.code)),
  check("roles_system_kind_valid", sql`${table.systemKind} IN ('custom', 'leader', 'administrator', 'doctor', 'rehabilitologist', 'massage_therapist', 'physiotherapist')`),
  check("roles_admin_assignable_bool", sql`${table.adminAssignable} IN (0, 1)`),
  check("roles_authorization_revision_positive", positiveVersion(table.authorizationRevision)),
  check("roles_version_positive", positiveVersion(table.version)),
]);

export const roleRevisions = crm.table("role_revisions", {
  id: uuid("id").primaryKey(),
  roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "restrict" }),
  revision: integer("revision").notNull(),
  publishedByEmployeeId: uuid("published_by_employee_id").references(() => employees.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
  capabilityHash: text("capability_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  unique("role_revisions_role_revision_unique").on(table.roleId, table.revision),
  check("role_revisions_revision_positive", sql`${table.revision} > 0`),
  check("role_revisions_reason_not_blank", nonBlank(table.reason)),
  check("role_revisions_capability_hash_not_blank", nonBlank(table.capabilityHash)),
]);

export const roleGrants = crm.table("role_grants", {
  id: uuid("id").primaryKey(),
  roleRevisionId: uuid("role_revision_id").notNull().references(() => roleRevisions.id, { onDelete: "restrict" }),
  permissionCode: text("permission_code").notNull().references(() => permissionCatalog.code, { onDelete: "restrict" }),
  scope: jsonb("scope").notNull(),
}, (table) => [
  unique("role_grants_revision_permission_unique").on(table.roleRevisionId, table.permissionCode),
]);

export const roleAssignments = crm.table("role_assignments", {
  id: uuid("id").primaryKey(),
  employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "restrict" }),
  employmentEpochId: uuid("employment_epoch_id").notNull().references(() => employmentEpochs.id, { onDelete: "restrict" }),
  roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "restrict" }),
  assignedByEmployeeId: uuid("assigned_by_employee_id").references(() => employees.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
  assignedAt: timestamp("assigned_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  version: integer("version").notNull().default(1),
}, (table) => [
  uniqueIndex("role_assignments_active_epoch_role_unique")
    .on(table.employmentEpochId, table.roleId)
    .where(sql`${table.revokedAt} IS NULL`),
  index("role_assignments_employee_active_idx").on(table.employeeId).where(sql`${table.revokedAt} IS NULL`),
  check("role_assignments_reason_not_blank", nonBlank(table.reason)),
  check("role_assignments_version_positive", positiveVersion(table.version)),
]);

export const employeePermissionOverrides = crm.table("employee_permission_overrides", {
  id: uuid("id").primaryKey(),
  employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "restrict" }),
  employmentEpochId: uuid("employment_epoch_id").notNull().references(() => employmentEpochs.id, { onDelete: "restrict" }),
  permissionCode: text("permission_code").notNull().references(() => permissionCatalog.code, { onDelete: "restrict" }),
  mode: text("mode").notNull(),
  scope: jsonb("scope"),
  grantedByEmployeeId: uuid("granted_by_employee_id").references(() => employees.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  version: integer("version").notNull().default(1),
}, (table) => [
  uniqueIndex("employee_permission_overrides_active_unique")
    .on(table.employmentEpochId, table.permissionCode)
    .where(sql`${table.revokedAt} IS NULL`),
  check("employee_permission_overrides_mode_valid", sql`${table.mode} IN ('replace', 'deny')`),
  check("employee_permission_overrides_reason_not_blank", nonBlank(table.reason)),
  check("employee_permission_overrides_scope_valid", sql`(${table.mode} = 'deny' AND ${table.scope} IS NULL) OR (${table.mode} = 'replace' AND ${table.scope} IS NOT NULL)`),
  check("employee_permission_overrides_version_positive", positiveVersion(table.version)),
]);

export const crmSessions = crm.table("crm_sessions", {
  id: uuid("id").primaryKey(),
  employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "restrict" }),
  employmentEpochId: uuid("employment_epoch_id").notNull().references(() => employmentEpochs.id, { onDelete: "restrict" }),
  authBindingId: uuid("auth_binding_id").notNull().references(() => authBindings.id, { onDelete: "restrict" }),
  providerSessionId: uuid("provider_session_id").notNull(),
  familyId: uuid("family_id").notNull(),
  issuedSessionEpoch: integer("issued_session_epoch").notNull(),
  issuedCredentialEpoch: integer("issued_credential_epoch").notNull(),
  accessTokenHash: text("access_token_hash").notNull(),
  refreshTokenHash: text("refresh_token_hash").notNull(),
  /** AES-GCM ciphertext of the provider refresh token; the browser never receives it. */
  providerRefreshTokenCiphertext: text("provider_refresh_token_ciphertext").notNull(),
  refreshGeneration: integer("refresh_generation").notNull().default(1),
  lastInteractiveAt: timestamp("last_interactive_at", { withTimezone: true, mode: "date" }).notNull(),
  idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true, mode: "date" }).notNull(),
  absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true, mode: "date" }).notNull(),
  status: text("status").notNull().default("active"),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  revokeReason: text("revoke_reason"),
  providerReconciledAt: timestamp("provider_reconciled_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  revision: integer("revision").notNull().default(1),
}, (table) => [
  unique("crm_sessions_provider_session_unique").on(table.providerSessionId),
  index("crm_sessions_employee_active_idx").on(table.employeeId, table.status).where(sql`${table.status} = 'active'`),
  index("crm_sessions_family_active_idx").on(table.familyId, table.status).where(sql`${table.status} = 'active'`),
  check("crm_sessions_status_valid", sql`${table.status} IN ('active', 'revoked', 'expired')`),
  check("crm_sessions_epochs_positive", sql`${table.issuedSessionEpoch} > 0 AND ${table.issuedCredentialEpoch} > 0 AND ${table.refreshGeneration} > 0 AND ${table.revision} > 0`),
  check("crm_sessions_deadlines_valid", sql`${table.idleExpiresAt} <= ${table.absoluteExpiresAt}`),
  check("crm_sessions_access_hash_not_blank", nonBlank(table.accessTokenHash)),
  check("crm_sessions_refresh_hash_not_blank", nonBlank(table.refreshTokenHash)),
  check("crm_sessions_provider_refresh_ciphertext_not_blank", nonBlank(table.providerRefreshTokenCiphertext)),
]);

/**
 * A durable, password-free record of every locally handled login attempt.
 * `attemptId` is supplied by the BFF client and makes a lost response safe to
 * retry without incrementing the lockout counter twice.
 */
export const authLoginAttempts = crm.table("auth_login_attempts", {
  id: uuid("id").primaryKey(),
  canonicalLogin: text("canonical_login").notNull(),
  employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "restrict" }),
  outcome: text("outcome").notNull(),
  providerAttempted: integer("provider_attempted").notNull().default(0),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  check("auth_login_attempts_login_not_blank", nonBlank(table.canonicalLogin)),
  check("auth_login_attempts_outcome_valid", sql`${table.outcome} IN ('succeeded', 'invalid_credentials', 'locked', 'inactive', 'provider_unavailable', 'reconciliation_required')`),
  check("auth_login_attempts_provider_attempted_bool", sql`${table.providerAttempted} IN (0, 1)`),
]);

/** One-time, server-owned recovery flow. Neither provider nor CRM tokens reach the browser. */
export const authRecoveryChallenges = crm.table("auth_recovery_challenges", {
  id: uuid("id").primaryKey(),
  employeeId: uuid("employee_id").notNull().references(() => employees.id, { onDelete: "restrict" }),
  employmentEpochId: uuid("employment_epoch_id").notNull().references(() => employmentEpochs.id, { onDelete: "restrict" }),
  authBindingId: uuid("auth_binding_id").notNull().references(() => authBindings.id, { onDelete: "restrict" }),
  stateVerifierHash: text("state_verifier_hash").notNull(),
  codeVerifierCiphertext: text("code_verifier_ciphertext").notNull(),
  recoveryGrantHash: text("recovery_grant_hash"),
  state: text("state").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("auth_recovery_challenges_one_active_per_employee_unique")
    .on(table.employeeId)
    .where(sql`${table.state} IN ('pending', 'verified')`),
  index("auth_recovery_challenges_expiry_idx").on(table.expiresAt),
  check("auth_recovery_challenges_state_valid", sql`${table.state} IN ('pending', 'verified', 'consumed', 'expired', 'quarantined')`),
  check("auth_recovery_challenges_state_hash_not_blank", nonBlank(table.stateVerifierHash)),
  check("auth_recovery_challenges_verifier_not_blank", nonBlank(table.codeVerifierCiphertext)),
  check("auth_recovery_challenges_grant_state_valid", sql`(${table.state} = 'verified' AND ${table.recoveryGrantHash} IS NOT NULL AND ${table.verifiedAt} IS NOT NULL) OR (${table.state} <> 'verified' AND ${table.recoveryGrantHash} IS NULL)`),
]);

export const securityOutbox = crm.table("security_outbox", {
  id: uuid("id").primaryKey(),
  operation: text("operation").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  expectedEpoch: integer("expected_epoch"),
  payload: jsonb("payload").notNull(),
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  unique("security_outbox_operation_aggregate_unique").on(table.operation, table.aggregateType, table.aggregateId),
  check("security_outbox_operation_not_blank", nonBlank(table.operation)),
  check("security_outbox_aggregate_type_not_blank", nonBlank(table.aggregateType)),
  check("security_outbox_state_valid", sql`${table.state} IN ('pending', 'processing', 'completed', 'failed', 'quarantined')`),
  check("security_outbox_attempts_nonnegative", sql`${table.attempts} >= 0`),
]);

export const patients = crm.table("patients", {
  id: uuid("id").primaryKey(),
  familyName: text("family_name").notNull(),
  givenName: text("given_name").notNull(),
  middleName: text("middle_name"),
  dateOfBirth: date("date_of_birth"),
  phone: text("phone"),
  email: text("email"),
  ...lifecycleColumns,
}, (table) => [
  index("patients_name_active_idx").on(table.familyName, table.givenName).where(active(table.archivedAt)),
  index("patients_phone_active_idx").on(table.phone).where(sql`${active(table.archivedAt)} AND ${table.phone} IS NOT NULL`),
  check("patients_family_name_not_blank", nonBlank(table.familyName)),
  check("patients_given_name_not_blank", nonBlank(table.givenName)),
  check("patients_version_positive", positiveVersion(table.version)),
]);

export const leads = crm.table("leads", {
  id: uuid("id").primaryKey(),
  fullName: text("full_name").notNull(),
  phone: text("phone").notNull(),
  status: text("status").notNull(),
  assignedEmployeeId: uuid("assigned_employee_id").references(() => employees.id, { onDelete: "restrict" }),
  convertedPatientId: uuid("converted_patient_id").references(() => patients.id, { onDelete: "restrict" }),
  ...lifecycleColumns,
}, (table) => [
  index("leads_assigned_employee_idx").on(table.assignedEmployeeId).where(sql`${table.assignedEmployeeId} IS NOT NULL`),
  index("leads_converted_patient_idx").on(table.convertedPatientId).where(sql`${table.convertedPatientId} IS NOT NULL`),
  index("leads_status_created_idx").on(table.status, table.createdAt).where(active(table.archivedAt)),
  check("leads_full_name_not_blank", nonBlank(table.fullName)),
  check("leads_phone_not_blank", nonBlank(table.phone)),
  check("leads_status_not_blank", nonBlank(table.status)),
  check("leads_version_positive", positiveVersion(table.version)),
]);

export const medicalCases = crm.table("medical_cases", {
  id: uuid("id").primaryKey(),
  patientId: uuid("patient_id").notNull().references(() => patients.id, { onDelete: "restrict" }),
  responsibleEmployeeId: uuid("responsible_employee_id").references(() => employees.id, { onDelete: "restrict" }),
  status: text("status").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true, mode: "date" }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
  ...lifecycleColumns,
}, (table) => [
  unique("medical_cases_id_patient_unique").on(table.id, table.patientId),
  index("medical_cases_patient_idx").on(table.patientId).where(active(table.archivedAt)),
  index("medical_cases_responsible_employee_idx").on(table.responsibleEmployeeId).where(sql`${table.responsibleEmployeeId} IS NOT NULL`),
  check("medical_cases_status_not_blank", nonBlank(table.status)),
  check("medical_cases_closed_after_opened", sql`${table.closedAt} IS NULL OR ${table.closedAt} >= ${table.openedAt}`),
  check("medical_cases_version_positive", positiveVersion(table.version)),
]);

export const services = crm.table("services", {
  id: uuid("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  deliveryMode: text("delivery_mode").notNull(),
  defaultDurationMinutes: integer("default_duration_minutes").notNull(),
  defaultPrice: numeric("default_price", { precision: 12, scale: 2 }).notNull(),
  defaultCapacity: integer("default_capacity").notNull().default(1),
  ...lifecycleColumns,
}, (table) => [
  unique("services_code_unique").on(table.code),
  check("services_code_not_blank", nonBlank(table.code)),
  check("services_name_not_blank", nonBlank(table.name)),
  check("services_delivery_mode_valid", sql`${table.deliveryMode} IN ('individual', 'group')`),
  check("services_duration_positive", sql`${table.defaultDurationMinutes} > 0`),
  check("services_price_nonnegative", sql`${table.defaultPrice} >= 0`),
  check("services_capacity_positive", sql`${table.defaultCapacity} > 0`),
  check("services_version_positive", positiveVersion(table.version)),
]);

export const rooms = crm.table("rooms", {
  id: uuid("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  capacity: integer("capacity").notNull(),
  ...lifecycleColumns,
}, (table) => [
  unique("rooms_code_unique").on(table.code),
  check("rooms_code_not_blank", nonBlank(table.code)),
  check("rooms_name_not_blank", nonBlank(table.name)),
  check("rooms_capacity_positive", sql`${table.capacity} > 0`),
  check("rooms_version_positive", positiveVersion(table.version)),
]);

export const appointmentSessions = crm.table("appointment_sessions", {
  id: uuid("id").primaryKey(),
  serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "restrict" }),
  primaryEmployeeId: uuid("primary_employee_id").notNull().references(() => employees.id, { onDelete: "restrict" }),
  roomId: uuid("room_id").references(() => rooms.id, { onDelete: "restrict" }),
  startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
  capacity: integer("capacity").notNull(),
  status: text("status").notNull(),
  ...lifecycleColumns,
}, (table) => [
  index("appointment_sessions_employee_starts_idx").on(table.primaryEmployeeId, table.startsAt).where(active(table.archivedAt)),
  index("appointment_sessions_room_starts_idx").on(table.roomId, table.startsAt).where(sql`${active(table.archivedAt)} AND ${table.roomId} IS NOT NULL`),
  index("appointment_sessions_service_idx").on(table.serviceId),
  index("appointment_sessions_status_starts_idx").on(table.status, table.startsAt).where(active(table.archivedAt)),
  check("appointment_sessions_range_valid", sql`${table.endsAt} > ${table.startsAt}`),
  check("appointment_sessions_capacity_positive", sql`${table.capacity} > 0`),
  check("appointment_sessions_status_not_blank", nonBlank(table.status)),
  check("appointment_sessions_version_positive", positiveVersion(table.version)),
]);

export const appointments = crm.table("appointments", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => appointmentSessions.id, { onDelete: "restrict" }),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "restrict" }),
  patientId: uuid("patient_id").references(() => patients.id, { onDelete: "restrict" }),
  medicalCaseId: uuid("medical_case_id"),
  status: text("status").notNull(),
  ...lifecycleColumns,
}, (table) => [
  unique("appointments_id_session_patient_unique").on(table.id, table.sessionId, table.patientId),
  foreignKey({
    name: "appointments_medical_case_patient_fk",
    columns: [table.medicalCaseId, table.patientId],
    foreignColumns: [medicalCases.id, medicalCases.patientId],
  }).onDelete("restrict"),
  index("appointments_session_idx").on(table.sessionId),
  index("appointments_patient_idx").on(table.patientId).where(sql`${table.patientId} IS NOT NULL`),
  index("appointments_medical_case_idx").on(table.medicalCaseId).where(sql`${table.medicalCaseId} IS NOT NULL`),
  index("appointments_lead_idx").on(table.leadId).where(sql`${table.leadId} IS NOT NULL`),
  check("appointments_subject_at_least_one", sql`num_nonnulls(${table.leadId}, ${table.patientId}) >= 1`),
  check("appointments_medical_case_requires_patient", sql`${table.medicalCaseId} IS NULL OR ${table.patientId} IS NOT NULL`),
  check("appointments_status_not_blank", nonBlank(table.status)),
  check("appointments_version_positive", positiveVersion(table.version)),
]);

export const appointmentParticipants = crm.table("appointment_participants", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull(),
  appointmentId: uuid("appointment_id").notNull(),
  patientId: uuid("patient_id").notNull(),
  attendanceStatus: text("attendance_status").notNull(),
  ...lifecycleColumns,
}, (table) => [
  foreignKey({
    name: "appointment_participants_appointment_session_patient_fk",
    columns: [table.appointmentId, table.sessionId, table.patientId],
    foreignColumns: [appointments.id, appointments.sessionId, appointments.patientId],
  }).onDelete("restrict"),
  unique("appointment_participants_session_patient_unique").on(table.sessionId, table.patientId),
  unique("appointment_participants_appointment_unique").on(table.appointmentId),
  index("appointment_participants_patient_idx").on(table.patientId),
  check("appointment_participants_attendance_status_not_blank", nonBlank(table.attendanceStatus)),
  check("appointment_participants_version_positive", positiveVersion(table.version)),
]);

/**
 * Append-only evidence for critical actions. There is deliberately no updated
 * timestamp or version: corrections are represented by a new audit event.
 */
export const auditEntries = crm.table("audit_entries", {
  id: uuid("id").primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  actorEmployeeId: uuid("actor_employee_id").references(() => employees.id, { onDelete: "restrict" }),
  action: text("action").notNull(),
  category: text("category").notNull(),
  viewScope: text("view_scope").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  reason: text("reason").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  index("audit_entries_occurred_at_idx").on(table.occurredAt),
  index("audit_entries_expiry_idx").on(table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
  index("audit_entries_entity_idx").on(table.entityType, table.entityId, table.occurredAt),
  check("audit_entries_action_not_blank", nonBlank(table.action)),
  check("audit_entries_category_not_blank", nonBlank(table.category)),
  check("audit_entries_view_scope_not_blank", nonBlank(table.viewScope)),
  check("audit_entries_entity_type_not_blank", nonBlank(table.entityType)),
  check("audit_entries_reason_not_blank", nonBlank(table.reason)),
]);

/** A completed command response is retained so a network retry can replay it. */
export const idempotencyKeys = crm.table("idempotency_keys", {
  id: uuid("id").primaryKey(),
  scope: text("scope").notNull(),
  operation: text("operation").notNull(),
  key: text("key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  state: text("state").notNull().default("pending"),
  responseStatus: integer("response_status"),
  response: jsonb("response"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true, mode: "date" }).defaultNow(),
}, (table) => [
  unique("idempotency_keys_scope_operation_key_unique").on(table.scope, table.operation, table.key),
  check("idempotency_keys_scope_not_blank", nonBlank(table.scope)),
  check("idempotency_keys_operation_not_blank", nonBlank(table.operation)),
  check("idempotency_keys_key_not_blank", nonBlank(table.key)),
  check("idempotency_keys_fingerprint_not_blank", nonBlank(table.requestFingerprint)),
  check("idempotency_keys_state_valid", sql`${table.state} IN ('pending', 'completed')`),
  check("idempotency_keys_response_status_valid", sql`${table.responseStatus} IS NULL OR ${table.responseStatus} BETWEEN 100 AND 599`),
  check("idempotency_keys_completed_result", sql`(${table.state} = 'pending' AND ${table.responseStatus} IS NULL AND ${table.response} IS NULL AND ${table.completedAt} IS NULL AND ${table.claimExpiresAt} IS NOT NULL) OR (${table.state} = 'completed' AND ${table.responseStatus} IS NOT NULL AND ${table.response} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`),
]);

/** Private proof for a pending command; crm_runtime has no direct access. */
export const idempotencyCompletionCapabilities = crm.table("idempotency_completion_capabilities", {
  idempotencyKeyId: uuid("idempotency_key_id").primaryKey().references(() => idempotencyKeys.id, { onDelete: "cascade" }),
  capability: text("capability").notNull(),
}, (table) => [
  check("idempotency_completion_capabilities_format", sql`${table.capability} ~ '^[0-9a-f]{64}$'`),
]);

/** One current policy. Historical policy changes remain in the append-only audit. */
export const auditRetentionPolicies = crm.table("audit_retention_policies", {
  id: uuid("id").primaryKey(),
  retentionDays: integer("retention_days"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  version: integer("version").notNull().default(1),
}, (table) => [
  uniqueIndex("audit_retention_policies_one_current_unique").on(sql`(true)`),
  check("audit_retention_policies_days_positive", sql`${table.retentionDays} IS NULL OR ${table.retentionDays} > 0`),
  check("audit_retention_policies_version_positive", positiveVersion(table.version)),
]);

export const appointmentSessionRelations = relations(appointmentSessions, ({ one, many }) => ({
  service: one(services, { fields: [appointmentSessions.serviceId], references: [services.id] }),
  primaryEmployee: one(employees, { fields: [appointmentSessions.primaryEmployeeId], references: [employees.id] }),
  room: one(rooms, { fields: [appointmentSessions.roomId], references: [rooms.id] }),
  appointments: many(appointments),
  participants: many(appointmentParticipants),
}));

export const employeeRelations = relations(employees, ({ many }) => ({ assignedLeads: many(leads), responsibleMedicalCases: many(medicalCases), primaryAppointmentSessions: many(appointmentSessions), auditEntries: many(auditEntries) }));
export const patientRelations = relations(patients, ({ many }) => ({ convertedLeads: many(leads), medicalCases: many(medicalCases), appointments: many(appointments), appointmentParticipants: many(appointmentParticipants) }));
export const leadRelations = relations(leads, ({ one, many }) => ({ assignedEmployee: one(employees, { fields: [leads.assignedEmployeeId], references: [employees.id] }), convertedPatient: one(patients, { fields: [leads.convertedPatientId], references: [patients.id] }), appointments: many(appointments) }));
export const medicalCaseRelations = relations(medicalCases, ({ one, many }) => ({ patient: one(patients, { fields: [medicalCases.patientId], references: [patients.id] }), responsibleEmployee: one(employees, { fields: [medicalCases.responsibleEmployeeId], references: [employees.id] }), appointments: many(appointments) }));
export const serviceRelations = relations(services, ({ many }) => ({ appointmentSessions: many(appointmentSessions) }));
export const roomRelations = relations(rooms, ({ many }) => ({ appointmentSessions: many(appointmentSessions) }));
export const appointmentRelations = relations(appointments, ({ one, many }) => ({ session: one(appointmentSessions, { fields: [appointments.sessionId], references: [appointmentSessions.id] }), lead: one(leads, { fields: [appointments.leadId], references: [leads.id] }), patient: one(patients, { fields: [appointments.patientId], references: [patients.id] }), medicalCase: one(medicalCases, { fields: [appointments.medicalCaseId], references: [medicalCases.id] }), participants: many(appointmentParticipants) }));
export const appointmentParticipantRelations = relations(appointmentParticipants, ({ one }) => ({ session: one(appointmentSessions, { fields: [appointmentParticipants.sessionId], references: [appointmentSessions.id] }), appointment: one(appointments, { fields: [appointmentParticipants.appointmentId], references: [appointments.id] }), patient: one(patients, { fields: [appointmentParticipants.patientId], references: [patients.id] }) }));
export const auditEntryRelations = relations(auditEntries, ({ one }) => ({ actorEmployee: one(employees, { fields: [auditEntries.actorEmployeeId], references: [employees.id] }) }));
