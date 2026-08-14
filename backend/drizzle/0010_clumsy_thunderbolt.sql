CREATE TABLE "crm"."auth_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"employment_epoch_id" uuid NOT NULL,
	"provider_namespace" text NOT NULL,
	"provider_subject_id" uuid NOT NULL,
	"provider_marker" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "auth_bindings_provider_subject_unique" UNIQUE("provider_namespace","provider_subject_id"),
	CONSTRAINT "auth_bindings_namespace_not_blank" CHECK (btrim("crm"."auth_bindings"."provider_namespace") <> ''),
	CONSTRAINT "auth_bindings_marker_not_blank" CHECK (btrim("crm"."auth_bindings"."provider_marker") <> ''),
	CONSTRAINT "auth_bindings_state_valid" CHECK ("crm"."auth_bindings"."state" IN ('reserved', 'confirmed', 'active', 'ended', 'quarantined'))
);
--> statement-breakpoint
CREATE TABLE "crm"."clinic_security_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"security_initialized_at" timestamp with time zone,
	"authorization_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_security_states_revision_positive" CHECK ("crm"."clinic_security_states"."authorization_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."crm_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"employee_id" uuid NOT NULL,
	"employment_epoch_id" uuid NOT NULL,
	"auth_binding_id" uuid NOT NULL,
	"provider_session_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"issued_session_epoch" integer NOT NULL,
	"issued_credential_epoch" integer NOT NULL,
	"access_token_hash" text NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"refresh_generation" integer DEFAULT 1 NOT NULL,
	"last_interactive_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"provider_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "crm_sessions_provider_session_unique" UNIQUE("provider_session_id"),
	CONSTRAINT "crm_sessions_status_valid" CHECK ("crm"."crm_sessions"."status" IN ('active', 'revoked', 'expired')),
	CONSTRAINT "crm_sessions_epochs_positive" CHECK ("crm"."crm_sessions"."issued_session_epoch" > 0 AND "crm"."crm_sessions"."issued_credential_epoch" > 0 AND "crm"."crm_sessions"."refresh_generation" > 0 AND "crm"."crm_sessions"."revision" > 0),
	CONSTRAINT "crm_sessions_deadlines_valid" CHECK ("crm"."crm_sessions"."idle_expires_at" <= "crm"."crm_sessions"."absolute_expires_at"),
	CONSTRAINT "crm_sessions_access_hash_not_blank" CHECK (btrim("crm"."crm_sessions"."access_token_hash") <> ''),
	CONSTRAINT "crm_sessions_refresh_hash_not_blank" CHECK (btrim("crm"."crm_sessions"."refresh_token_hash") <> '')
);
--> statement-breakpoint
CREATE TABLE "crm"."employee_permission_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"employee_id" uuid NOT NULL,
	"employment_epoch_id" uuid NOT NULL,
	"permission_code" text NOT NULL,
	"mode" text NOT NULL,
	"scope" jsonb,
	"granted_by_employee_id" uuid,
	"reason" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "employee_permission_overrides_mode_valid" CHECK ("crm"."employee_permission_overrides"."mode" IN ('replace', 'deny')),
	CONSTRAINT "employee_permission_overrides_reason_not_blank" CHECK (btrim("crm"."employee_permission_overrides"."reason") <> ''),
	CONSTRAINT "employee_permission_overrides_scope_valid" CHECK (("crm"."employee_permission_overrides"."mode" = 'deny' AND "crm"."employee_permission_overrides"."scope" IS NULL) OR ("crm"."employee_permission_overrides"."mode" = 'replace' AND "crm"."employee_permission_overrides"."scope" IS NOT NULL)),
	CONSTRAINT "employee_permission_overrides_version_positive" CHECK ("crm"."employee_permission_overrides"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."employee_security_states" (
	"employee_id" uuid PRIMARY KEY NOT NULL,
	"employment_epoch_id" uuid,
	"access_state" text DEFAULT 'suspended' NOT NULL,
	"credential_state" text DEFAULT 'unready' NOT NULL,
	"login_failure_count" integer DEFAULT 0 NOT NULL,
	"login_locked_until" timestamp with time zone,
	"session_epoch" integer DEFAULT 1 NOT NULL,
	"credential_epoch" integer DEFAULT 1 NOT NULL,
	"authorization_revision" integer DEFAULT 1 NOT NULL,
	"provider_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "employee_security_states_access_valid" CHECK ("crm"."employee_security_states"."access_state" IN ('active', 'suspended', 'security_quarantined', 'terminated')),
	CONSTRAINT "employee_security_states_credential_valid" CHECK ("crm"."employee_security_states"."credential_state" IN ('unready', 'temporary_password', 'ready', 'password_change_required', 'changing', 'reconciliation_required', 'disabled')),
	CONSTRAINT "employee_security_states_failure_count_valid" CHECK ("crm"."employee_security_states"."login_failure_count" BETWEEN 0 AND 5),
	CONSTRAINT "employee_security_states_session_epoch_positive" CHECK ("crm"."employee_security_states"."session_epoch" > 0),
	CONSTRAINT "employee_security_states_credential_epoch_positive" CHECK ("crm"."employee_security_states"."credential_epoch" > 0),
	CONSTRAINT "employee_security_states_authorization_revision_positive" CHECK ("crm"."employee_security_states"."authorization_revision" > 0),
	CONSTRAINT "employee_security_states_version_positive" CHECK ("crm"."employee_security_states"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."employment_epochs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"employee_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "employment_epochs_employee_sequence_unique" UNIQUE("employee_id","sequence"),
	CONSTRAINT "employment_epochs_state_valid" CHECK ("crm"."employment_epochs"."state" IN ('reserved', 'provider_creating', 'provider_confirmed', 'activating', 'active', 'offboarding', 'terminated', 'failed', 'cancelled', 'quarantined')),
	CONSTRAINT "employment_epochs_sequence_positive" CHECK ("crm"."employment_epochs"."sequence" > 0),
	CONSTRAINT "employment_epochs_version_positive" CHECK ("crm"."employment_epochs"."version" > 0),
	CONSTRAINT "employment_epochs_interval_valid" CHECK ("crm"."employment_epochs"."ended_at" IS NULL OR "crm"."employment_epochs"."started_at" IS NULL OR "crm"."employment_epochs"."ended_at" >= "crm"."employment_epochs"."started_at")
);
--> statement-breakpoint
CREATE TABLE "crm"."login_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"canonical_login" text NOT NULL,
	"employment_epoch_id" uuid,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "login_claims_canonical_login_unique" UNIQUE("canonical_login"),
	CONSTRAINT "login_claims_canonical_login_not_blank" CHECK (btrim("crm"."login_claims"."canonical_login") <> ''),
	CONSTRAINT "login_claims_state_valid" CHECK ("crm"."login_claims"."state" IN ('reserved', 'active', 'tombstoned', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "crm"."permission_catalog" (
	"code" text PRIMARY KEY NOT NULL,
	"resource_family" text NOT NULL,
	"is_sensitive" integer DEFAULT 0 NOT NULL,
	"is_governance" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_catalog_code_not_blank" CHECK (btrim("crm"."permission_catalog"."code") <> ''),
	CONSTRAINT "permission_catalog_family_not_blank" CHECK (btrim("crm"."permission_catalog"."resource_family") <> ''),
	CONSTRAINT "permission_catalog_sensitive_bool" CHECK ("crm"."permission_catalog"."is_sensitive" IN (0, 1)),
	CONSTRAINT "permission_catalog_governance_bool" CHECK ("crm"."permission_catalog"."is_governance" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE "crm"."role_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"employee_id" uuid NOT NULL,
	"employment_epoch_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_by_employee_id" uuid,
	"reason" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "role_assignments_reason_not_blank" CHECK (btrim("crm"."role_assignments"."reason") <> ''),
	CONSTRAINT "role_assignments_version_positive" CHECK ("crm"."role_assignments"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."role_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role_revision_id" uuid NOT NULL,
	"permission_code" text NOT NULL,
	"scope" jsonb NOT NULL,
	CONSTRAINT "role_grants_revision_permission_unique" UNIQUE("role_revision_id","permission_code")
);
--> statement-breakpoint
CREATE TABLE "crm"."role_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"published_by_employee_id" uuid,
	"reason" text NOT NULL,
	"capability_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_revisions_role_revision_unique" UNIQUE("role_id","revision"),
	CONSTRAINT "role_revisions_revision_positive" CHECK ("crm"."role_revisions"."revision" > 0),
	CONSTRAINT "role_revisions_reason_not_blank" CHECK (btrim("crm"."role_revisions"."reason") <> ''),
	CONSTRAINT "role_revisions_capability_hash_not_blank" CHECK (btrim("crm"."role_revisions"."capability_hash") <> '')
);
--> statement-breakpoint
CREATE TABLE "crm"."roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"system_kind" text DEFAULT 'custom' NOT NULL,
	"current_revision_id" uuid,
	"admin_assignable" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"authorization_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "roles_code_unique" UNIQUE("code"),
	CONSTRAINT "roles_code_not_blank" CHECK (btrim("crm"."roles"."code") <> ''),
	CONSTRAINT "roles_system_kind_valid" CHECK ("crm"."roles"."system_kind" IN ('custom', 'leader', 'administrator', 'doctor', 'rehabilitologist', 'massage_therapist', 'physiotherapist')),
	CONSTRAINT "roles_admin_assignable_bool" CHECK ("crm"."roles"."admin_assignable" IN (0, 1)),
	CONSTRAINT "roles_authorization_revision_positive" CHECK ("crm"."roles"."authorization_revision" > 0),
	CONSTRAINT "roles_version_positive" CHECK ("crm"."roles"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."security_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"expected_epoch" integer,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_outbox_operation_aggregate_unique" UNIQUE("operation","aggregate_type","aggregate_id"),
	CONSTRAINT "security_outbox_operation_not_blank" CHECK (btrim("crm"."security_outbox"."operation") <> ''),
	CONSTRAINT "security_outbox_aggregate_type_not_blank" CHECK (btrim("crm"."security_outbox"."aggregate_type") <> ''),
	CONSTRAINT "security_outbox_state_valid" CHECK ("crm"."security_outbox"."state" IN ('pending', 'processing', 'completed', 'failed', 'quarantined')),
	CONSTRAINT "security_outbox_attempts_nonnegative" CHECK ("crm"."security_outbox"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "crm"."employees" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "crm"."employees" ADD COLUMN "current_employment_epoch_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."auth_bindings" ADD CONSTRAINT "auth_bindings_employment_epoch_id_employment_epochs_id_fk" FOREIGN KEY ("employment_epoch_id") REFERENCES "crm"."employment_epochs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."crm_sessions" ADD CONSTRAINT "crm_sessions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "crm"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."crm_sessions" ADD CONSTRAINT "crm_sessions_employment_epoch_id_employment_epochs_id_fk" FOREIGN KEY ("employment_epoch_id") REFERENCES "crm"."employment_epochs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."crm_sessions" ADD CONSTRAINT "crm_sessions_auth_binding_id_auth_bindings_id_fk" FOREIGN KEY ("auth_binding_id") REFERENCES "crm"."auth_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."employee_permission_overrides" ADD CONSTRAINT "employee_permission_overrides_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "crm"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."employee_permission_overrides" ADD CONSTRAINT "employee_permission_overrides_employment_epoch_id_employment_epochs_id_fk" FOREIGN KEY ("employment_epoch_id") REFERENCES "crm"."employment_epochs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."employee_permission_overrides" ADD CONSTRAINT "employee_permission_overrides_permission_code_permission_catalog_code_fk" FOREIGN KEY ("permission_code") REFERENCES "crm"."permission_catalog"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."employee_permission_overrides" ADD CONSTRAINT "employee_permission_overrides_granted_by_employee_id_employees_id_fk" FOREIGN KEY ("granted_by_employee_id") REFERENCES "crm"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."employee_security_states" ADD CONSTRAINT "employee_security_states_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "crm"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."employee_security_states" ADD CONSTRAINT "employee_security_states_employment_epoch_id_employment_epochs_id_fk" FOREIGN KEY ("employment_epoch_id") REFERENCES "crm"."employment_epochs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."employment_epochs" ADD CONSTRAINT "employment_epochs_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "crm"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."login_claims" ADD CONSTRAINT "login_claims_employment_epoch_id_employment_epochs_id_fk" FOREIGN KEY ("employment_epoch_id") REFERENCES "crm"."employment_epochs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."role_assignments" ADD CONSTRAINT "role_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "crm"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."role_assignments" ADD CONSTRAINT "role_assignments_employment_epoch_id_employment_epochs_id_fk" FOREIGN KEY ("employment_epoch_id") REFERENCES "crm"."employment_epochs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."role_assignments" ADD CONSTRAINT "role_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "crm"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."role_assignments" ADD CONSTRAINT "role_assignments_assigned_by_employee_id_employees_id_fk" FOREIGN KEY ("assigned_by_employee_id") REFERENCES "crm"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."role_grants" ADD CONSTRAINT "role_grants_role_revision_id_role_revisions_id_fk" FOREIGN KEY ("role_revision_id") REFERENCES "crm"."role_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."role_grants" ADD CONSTRAINT "role_grants_permission_code_permission_catalog_code_fk" FOREIGN KEY ("permission_code") REFERENCES "crm"."permission_catalog"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."role_revisions" ADD CONSTRAINT "role_revisions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "crm"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."role_revisions" ADD CONSTRAINT "role_revisions_published_by_employee_id_employees_id_fk" FOREIGN KEY ("published_by_employee_id") REFERENCES "crm"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_bindings_one_current_epoch_unique" ON "crm"."auth_bindings" USING btree ("employment_epoch_id") WHERE "crm"."auth_bindings"."state" IN ('reserved', 'confirmed', 'active');--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_security_states_one_current_unique" ON "crm"."clinic_security_states" USING btree ((true));--> statement-breakpoint
CREATE INDEX "crm_sessions_employee_active_idx" ON "crm"."crm_sessions" USING btree ("employee_id","status") WHERE "crm"."crm_sessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "crm_sessions_family_active_idx" ON "crm"."crm_sessions" USING btree ("family_id","status") WHERE "crm"."crm_sessions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "employee_permission_overrides_active_unique" ON "crm"."employee_permission_overrides" USING btree ("employment_epoch_id","permission_code") WHERE "crm"."employee_permission_overrides"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_security_states_epoch_unique" ON "crm"."employee_security_states" USING btree ("employment_epoch_id") WHERE "crm"."employee_security_states"."employment_epoch_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employment_epochs_one_current_per_employee_unique" ON "crm"."employment_epochs" USING btree ("employee_id") WHERE "crm"."employment_epochs"."state" IN ('reserved', 'provider_creating', 'provider_confirmed', 'activating', 'active', 'offboarding');--> statement-breakpoint
CREATE INDEX "employment_epochs_employee_state_idx" ON "crm"."employment_epochs" USING btree ("employee_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "role_assignments_active_epoch_role_unique" ON "crm"."role_assignments" USING btree ("employment_epoch_id","role_id") WHERE "crm"."role_assignments"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "role_assignments_employee_active_idx" ON "crm"."role_assignments" USING btree ("employee_id") WHERE "crm"."role_assignments"."revoked_at" IS NULL;