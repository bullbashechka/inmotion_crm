CREATE TABLE "crm"."auth_login_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"canonical_login" text NOT NULL,
	"employee_id" uuid,
	"outcome" text NOT NULL,
	"provider_attempted" integer DEFAULT 0 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_login_attempts_login_not_blank" CHECK (btrim("crm"."auth_login_attempts"."canonical_login") <> ''),
	CONSTRAINT "auth_login_attempts_outcome_valid" CHECK ("crm"."auth_login_attempts"."outcome" IN ('succeeded', 'invalid_credentials', 'locked', 'inactive', 'provider_unavailable', 'reconciliation_required')),
	CONSTRAINT "auth_login_attempts_provider_attempted_bool" CHECK ("crm"."auth_login_attempts"."provider_attempted" IN (0, 1))
);
--> statement-breakpoint
ALTER TABLE "crm"."crm_sessions" ADD COLUMN "provider_refresh_token_ciphertext" text NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."auth_login_attempts" ADD CONSTRAINT "auth_login_attempts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "crm"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."crm_sessions" ADD CONSTRAINT "crm_sessions_provider_refresh_ciphertext_not_blank" CHECK (btrim("crm"."crm_sessions"."provider_refresh_token_ciphertext") <> '');