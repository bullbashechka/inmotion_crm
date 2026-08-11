CREATE SCHEMA "crm";
--> statement-breakpoint
CREATE TABLE "crm"."appointment_participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"attendance_status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "appointment_participants_session_patient_unique" UNIQUE("session_id","patient_id"),
	CONSTRAINT "appointment_participants_appointment_unique" UNIQUE("appointment_id"),
	CONSTRAINT "appointment_participants_attendance_status_not_blank" CHECK (btrim("crm"."appointment_participants"."attendance_status") <> ''),
	CONSTRAINT "appointment_participants_version_positive" CHECK ("crm"."appointment_participants"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."appointment_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"service_id" uuid NOT NULL,
	"primary_employee_id" uuid NOT NULL,
	"room_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"capacity" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "appointment_sessions_range_valid" CHECK ("crm"."appointment_sessions"."ends_at" > "crm"."appointment_sessions"."starts_at"),
	CONSTRAINT "appointment_sessions_capacity_positive" CHECK ("crm"."appointment_sessions"."capacity" > 0),
	CONSTRAINT "appointment_sessions_status_not_blank" CHECK (btrim("crm"."appointment_sessions"."status") <> ''),
	CONSTRAINT "appointment_sessions_version_positive" CHECK ("crm"."appointment_sessions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."appointments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"lead_id" uuid,
	"patient_id" uuid,
	"medical_case_id" uuid,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "appointments_id_session_patient_unique" UNIQUE("id","session_id","patient_id"),
	CONSTRAINT "appointments_subject_exactly_one" CHECK (num_nonnulls("crm"."appointments"."lead_id", "crm"."appointments"."patient_id") = 1),
	CONSTRAINT "appointments_medical_case_requires_patient" CHECK ("crm"."appointments"."medical_case_id" IS NULL OR "crm"."appointments"."patient_id" IS NOT NULL),
	CONSTRAINT "appointments_status_not_blank" CHECK (btrim("crm"."appointments"."status") <> ''),
	CONSTRAINT "appointments_version_positive" CHECK ("crm"."appointments"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."clinic_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clinic_name" text NOT NULL,
	"timezone" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "clinic_settings_clinic_name_not_blank" CHECK (btrim("crm"."clinic_settings"."clinic_name") <> ''),
	CONSTRAINT "clinic_settings_timezone_not_blank" CHECK (btrim("crm"."clinic_settings"."timezone") <> ''),
	CONSTRAINT "clinic_settings_version_positive" CHECK ("crm"."clinic_settings"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."employees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"auth_subject_id" uuid,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "employees_auth_subject_unique" UNIQUE("auth_subject_id"),
	CONSTRAINT "employees_full_name_not_blank" CHECK (btrim("crm"."employees"."full_name") <> ''),
	CONSTRAINT "employees_email_not_blank" CHECK (btrim("crm"."employees"."email") <> ''),
	CONSTRAINT "employees_version_positive" CHECK ("crm"."employees"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."leads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"phone" text NOT NULL,
	"status" text NOT NULL,
	"assigned_employee_id" uuid,
	"converted_patient_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "leads_full_name_not_blank" CHECK (btrim("crm"."leads"."full_name") <> ''),
	CONSTRAINT "leads_phone_not_blank" CHECK (btrim("crm"."leads"."phone") <> ''),
	CONSTRAINT "leads_status_not_blank" CHECK (btrim("crm"."leads"."status") <> ''),
	CONSTRAINT "leads_version_positive" CHECK ("crm"."leads"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."medical_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"patient_id" uuid NOT NULL,
	"responsible_employee_id" uuid,
	"status" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "medical_cases_id_patient_unique" UNIQUE("id","patient_id"),
	CONSTRAINT "medical_cases_status_not_blank" CHECK (btrim("crm"."medical_cases"."status") <> ''),
	CONSTRAINT "medical_cases_closed_after_opened" CHECK ("crm"."medical_cases"."closed_at" IS NULL OR "crm"."medical_cases"."closed_at" >= "crm"."medical_cases"."opened_at"),
	CONSTRAINT "medical_cases_version_positive" CHECK ("crm"."medical_cases"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."patients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"family_name" text NOT NULL,
	"given_name" text NOT NULL,
	"middle_name" text,
	"date_of_birth" date,
	"phone" text,
	"email" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "patients_family_name_not_blank" CHECK (btrim("crm"."patients"."family_name") <> ''),
	CONSTRAINT "patients_given_name_not_blank" CHECK (btrim("crm"."patients"."given_name") <> ''),
	CONSTRAINT "patients_version_positive" CHECK ("crm"."patients"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"capacity" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "rooms_code_unique" UNIQUE("code"),
	CONSTRAINT "rooms_code_not_blank" CHECK (btrim("crm"."rooms"."code") <> ''),
	CONSTRAINT "rooms_name_not_blank" CHECK (btrim("crm"."rooms"."name") <> ''),
	CONSTRAINT "rooms_capacity_positive" CHECK ("crm"."rooms"."capacity" > 0),
	CONSTRAINT "rooms_version_positive" CHECK ("crm"."rooms"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"delivery_mode" text NOT NULL,
	"default_duration_minutes" integer NOT NULL,
	"default_price" numeric(12, 2) NOT NULL,
	"default_capacity" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "services_code_unique" UNIQUE("code"),
	CONSTRAINT "services_code_not_blank" CHECK (btrim("crm"."services"."code") <> ''),
	CONSTRAINT "services_name_not_blank" CHECK (btrim("crm"."services"."name") <> ''),
	CONSTRAINT "services_delivery_mode_valid" CHECK ("crm"."services"."delivery_mode" IN ('individual', 'group')),
	CONSTRAINT "services_duration_positive" CHECK ("crm"."services"."default_duration_minutes" > 0),
	CONSTRAINT "services_price_nonnegative" CHECK ("crm"."services"."default_price" >= 0),
	CONSTRAINT "services_capacity_positive" CHECK ("crm"."services"."default_capacity" > 0),
	CONSTRAINT "services_version_positive" CHECK ("crm"."services"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "crm"."appointment_participants" ADD CONSTRAINT "appointment_participants_appointment_session_patient_fk" FOREIGN KEY ("appointment_id","session_id","patient_id") REFERENCES "crm"."appointments"("id","session_id","patient_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."appointment_sessions" ADD CONSTRAINT "appointment_sessions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "crm"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."appointment_sessions" ADD CONSTRAINT "appointment_sessions_primary_employee_id_employees_id_fk" FOREIGN KEY ("primary_employee_id") REFERENCES "crm"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."appointment_sessions" ADD CONSTRAINT "appointment_sessions_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "crm"."rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."appointments" ADD CONSTRAINT "appointments_session_id_appointment_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "crm"."appointment_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."appointments" ADD CONSTRAINT "appointments_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "crm"."leads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."appointments" ADD CONSTRAINT "appointments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "crm"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."appointments" ADD CONSTRAINT "appointments_medical_case_patient_fk" FOREIGN KEY ("medical_case_id","patient_id") REFERENCES "crm"."medical_cases"("id","patient_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."leads" ADD CONSTRAINT "leads_assigned_employee_id_employees_id_fk" FOREIGN KEY ("assigned_employee_id") REFERENCES "crm"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."leads" ADD CONSTRAINT "leads_converted_patient_id_patients_id_fk" FOREIGN KEY ("converted_patient_id") REFERENCES "crm"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."medical_cases" ADD CONSTRAINT "medical_cases_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "crm"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."medical_cases" ADD CONSTRAINT "medical_cases_responsible_employee_id_employees_id_fk" FOREIGN KEY ("responsible_employee_id") REFERENCES "crm"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_participants_patient_idx" ON "crm"."appointment_participants" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "appointment_sessions_employee_starts_idx" ON "crm"."appointment_sessions" USING btree ("primary_employee_id","starts_at") WHERE "crm"."appointment_sessions"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "appointment_sessions_room_starts_idx" ON "crm"."appointment_sessions" USING btree ("room_id","starts_at") WHERE "crm"."appointment_sessions"."archived_at" IS NULL AND "crm"."appointment_sessions"."room_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "appointment_sessions_service_idx" ON "crm"."appointment_sessions" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "appointment_sessions_status_starts_idx" ON "crm"."appointment_sessions" USING btree ("status","starts_at") WHERE "crm"."appointment_sessions"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "appointments_session_idx" ON "crm"."appointments" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "appointments_patient_idx" ON "crm"."appointments" USING btree ("patient_id") WHERE "crm"."appointments"."patient_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "appointments_medical_case_idx" ON "crm"."appointments" USING btree ("medical_case_id") WHERE "crm"."appointments"."medical_case_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "appointments_lead_idx" ON "crm"."appointments" USING btree ("lead_id") WHERE "crm"."appointments"."lead_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_email_unique" ON "crm"."employees" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "leads_assigned_employee_idx" ON "crm"."leads" USING btree ("assigned_employee_id") WHERE "crm"."leads"."assigned_employee_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "leads_converted_patient_idx" ON "crm"."leads" USING btree ("converted_patient_id") WHERE "crm"."leads"."converted_patient_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "leads_status_created_idx" ON "crm"."leads" USING btree ("status","created_at") WHERE "crm"."leads"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "medical_cases_patient_idx" ON "crm"."medical_cases" USING btree ("patient_id") WHERE "crm"."medical_cases"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "medical_cases_responsible_employee_idx" ON "crm"."medical_cases" USING btree ("responsible_employee_id") WHERE "crm"."medical_cases"."responsible_employee_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "patients_name_active_idx" ON "crm"."patients" USING btree ("family_name","given_name") WHERE "crm"."patients"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "patients_phone_active_idx" ON "crm"."patients" USING btree ("phone") WHERE "crm"."patients"."archived_at" IS NULL AND "crm"."patients"."phone" IS NOT NULL;