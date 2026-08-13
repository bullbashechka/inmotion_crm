CREATE TABLE "crm"."idempotency_completion_capabilities" (
	"idempotency_key_id" uuid PRIMARY KEY NOT NULL,
	"capability" text NOT NULL,
	CONSTRAINT "idempotency_completion_capabilities_format" CHECK ("crm"."idempotency_completion_capabilities"."capability" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "crm"."idempotency_keys" DROP CONSTRAINT "idempotency_keys_completed_result";--> statement-breakpoint
ALTER TABLE "crm"."idempotency_keys" ADD COLUMN "claim_expires_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "crm"."idempotency_completion_capabilities" ADD CONSTRAINT "idempotency_completion_capabilities_idempotency_key_id_idempotency_keys_id_fk" FOREIGN KEY ("idempotency_key_id") REFERENCES "crm"."idempotency_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_completed_result" CHECK (("crm"."idempotency_keys"."state" = 'pending' AND "crm"."idempotency_keys"."response_status" IS NULL AND "crm"."idempotency_keys"."response" IS NULL AND "crm"."idempotency_keys"."completed_at" IS NULL AND "crm"."idempotency_keys"."claim_expires_at" IS NOT NULL) OR ("crm"."idempotency_keys"."state" = 'completed' AND "crm"."idempotency_keys"."response_status" IS NOT NULL AND "crm"."idempotency_keys"."response" IS NOT NULL AND "crm"."idempotency_keys"."completed_at" IS NOT NULL));