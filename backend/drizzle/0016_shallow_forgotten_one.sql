CREATE TABLE "crm"."auth_recovery_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"employee_id" uuid NOT NULL,
	"employment_epoch_id" uuid NOT NULL,
	"auth_binding_id" uuid NOT NULL,
	"state_verifier_hash" text NOT NULL,
	"code_verifier_ciphertext" text NOT NULL,
	"recovery_grant_hash" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_recovery_challenges_state_valid" CHECK ("crm"."auth_recovery_challenges"."state" IN ('pending', 'verified', 'consumed', 'expired', 'quarantined')),
	CONSTRAINT "auth_recovery_challenges_state_hash_not_blank" CHECK (btrim("crm"."auth_recovery_challenges"."state_verifier_hash") <> ''),
	CONSTRAINT "auth_recovery_challenges_verifier_not_blank" CHECK (btrim("crm"."auth_recovery_challenges"."code_verifier_ciphertext") <> ''),
	CONSTRAINT "auth_recovery_challenges_grant_state_valid" CHECK (("crm"."auth_recovery_challenges"."state" = 'verified' AND "crm"."auth_recovery_challenges"."recovery_grant_hash" IS NOT NULL AND "crm"."auth_recovery_challenges"."verified_at" IS NOT NULL) OR ("crm"."auth_recovery_challenges"."state" <> 'verified' AND "crm"."auth_recovery_challenges"."recovery_grant_hash" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "crm"."auth_recovery_challenges" ADD CONSTRAINT "auth_recovery_challenges_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "crm"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."auth_recovery_challenges" ADD CONSTRAINT "auth_recovery_challenges_employment_epoch_id_employment_epochs_id_fk" FOREIGN KEY ("employment_epoch_id") REFERENCES "crm"."employment_epochs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."auth_recovery_challenges" ADD CONSTRAINT "auth_recovery_challenges_auth_binding_id_auth_bindings_id_fk" FOREIGN KEY ("auth_binding_id") REFERENCES "crm"."auth_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_recovery_challenges_one_active_per_employee_unique" ON "crm"."auth_recovery_challenges" USING btree ("employee_id") WHERE "crm"."auth_recovery_challenges"."state" IN ('pending', 'verified');--> statement-breakpoint
CREATE INDEX "auth_recovery_challenges_expiry_idx" ON "crm"."auth_recovery_challenges" USING btree ("expires_at");