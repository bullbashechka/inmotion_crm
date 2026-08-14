ALTER TABLE "crm"."audit_entries" ALTER COLUMN "occurred_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "crm"."audit_entries" ALTER COLUMN "reason" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."audit_retention_policies" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "crm"."audit_retention_policies" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "crm"."idempotency_keys" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "crm"."audit_entries" ADD CONSTRAINT "audit_entries_reason_not_blank" CHECK (btrim("crm"."audit_entries"."reason") <> '');--> statement-breakpoint
ALTER TABLE "crm"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_response_status_valid" CHECK ("crm"."idempotency_keys"."response_status" IS NULL OR "crm"."idempotency_keys"."response_status" BETWEEN 100 AND 599);