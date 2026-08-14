CREATE TABLE "crm"."audit_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_employee_id" uuid,
	"action" text NOT NULL,
	"category" text NOT NULL,
	"view_scope" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"expires_at" timestamp with time zone,
	CONSTRAINT "audit_entries_action_not_blank" CHECK (btrim("crm"."audit_entries"."action") <> ''),
	CONSTRAINT "audit_entries_category_not_blank" CHECK (btrim("crm"."audit_entries"."category") <> ''),
	CONSTRAINT "audit_entries_view_scope_not_blank" CHECK (btrim("crm"."audit_entries"."view_scope") <> ''),
	CONSTRAINT "audit_entries_entity_type_not_blank" CHECK (btrim("crm"."audit_entries"."entity_type") <> '')
);
--> statement-breakpoint
CREATE TABLE "crm"."audit_retention_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"retention_days" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "audit_retention_policies_days_positive" CHECK ("crm"."audit_retention_policies"."retention_days" IS NULL OR "crm"."audit_retention_policies"."retention_days" > 0),
	CONSTRAINT "audit_retention_policies_version_positive" CHECK ("crm"."audit_retention_policies"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."idempotency_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"response_status" integer,
	"response" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "idempotency_keys_scope_operation_key_unique" UNIQUE("scope","operation","key"),
	CONSTRAINT "idempotency_keys_scope_not_blank" CHECK (btrim("crm"."idempotency_keys"."scope") <> ''),
	CONSTRAINT "idempotency_keys_operation_not_blank" CHECK (btrim("crm"."idempotency_keys"."operation") <> ''),
	CONSTRAINT "idempotency_keys_key_not_blank" CHECK (btrim("crm"."idempotency_keys"."key") <> ''),
	CONSTRAINT "idempotency_keys_fingerprint_not_blank" CHECK (btrim("crm"."idempotency_keys"."request_fingerprint") <> ''),
	CONSTRAINT "idempotency_keys_state_valid" CHECK ("crm"."idempotency_keys"."state" IN ('pending', 'completed')),
	CONSTRAINT "idempotency_keys_completed_result" CHECK (("crm"."idempotency_keys"."state" = 'pending' AND "crm"."idempotency_keys"."response_status" IS NULL AND "crm"."idempotency_keys"."response" IS NULL AND "crm"."idempotency_keys"."completed_at" IS NULL) OR ("crm"."idempotency_keys"."state" = 'completed' AND "crm"."idempotency_keys"."response_status" IS NOT NULL AND "crm"."idempotency_keys"."response" IS NOT NULL AND "crm"."idempotency_keys"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "crm"."audit_entries" ADD CONSTRAINT "audit_entries_actor_employee_id_employees_id_fk" FOREIGN KEY ("actor_employee_id") REFERENCES "crm"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entries_occurred_at_idx" ON "crm"."audit_entries" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_entries_expiry_idx" ON "crm"."audit_entries" USING btree ("expires_at") WHERE "crm"."audit_entries"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_entries_entity_idx" ON "crm"."audit_entries" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_retention_policies_one_current_unique" ON "crm"."audit_retention_policies" USING btree ((true));