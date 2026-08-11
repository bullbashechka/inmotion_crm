import { relations, sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
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
  authSubjectId: uuid("auth_subject_id"),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  ...lifecycleColumns,
}, (table) => [
  unique("employees_auth_subject_unique").on(table.authSubjectId),
  uniqueIndex("employees_email_unique").on(sql`lower(${table.email})`),
  check("employees_full_name_not_blank", nonBlank(table.fullName)),
  check("employees_email_not_blank", nonBlank(table.email)),
  check("employees_version_positive", positiveVersion(table.version)),
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

export const appointmentSessionRelations = relations(appointmentSessions, ({ one, many }) => ({
  service: one(services, { fields: [appointmentSessions.serviceId], references: [services.id] }),
  primaryEmployee: one(employees, { fields: [appointmentSessions.primaryEmployeeId], references: [employees.id] }),
  room: one(rooms, { fields: [appointmentSessions.roomId], references: [rooms.id] }),
  appointments: many(appointments),
  participants: many(appointmentParticipants),
}));

export const employeeRelations = relations(employees, ({ many }) => ({ assignedLeads: many(leads), responsibleMedicalCases: many(medicalCases), primaryAppointmentSessions: many(appointmentSessions) }));
export const patientRelations = relations(patients, ({ many }) => ({ convertedLeads: many(leads), medicalCases: many(medicalCases), appointments: many(appointments), appointmentParticipants: many(appointmentParticipants) }));
export const leadRelations = relations(leads, ({ one, many }) => ({ assignedEmployee: one(employees, { fields: [leads.assignedEmployeeId], references: [employees.id] }), convertedPatient: one(patients, { fields: [leads.convertedPatientId], references: [patients.id] }), appointments: many(appointments) }));
export const medicalCaseRelations = relations(medicalCases, ({ one, many }) => ({ patient: one(patients, { fields: [medicalCases.patientId], references: [patients.id] }), responsibleEmployee: one(employees, { fields: [medicalCases.responsibleEmployeeId], references: [employees.id] }), appointments: many(appointments) }));
export const serviceRelations = relations(services, ({ many }) => ({ appointmentSessions: many(appointmentSessions) }));
export const roomRelations = relations(rooms, ({ many }) => ({ appointmentSessions: many(appointmentSessions) }));
export const appointmentRelations = relations(appointments, ({ one, many }) => ({ session: one(appointmentSessions, { fields: [appointments.sessionId], references: [appointmentSessions.id] }), lead: one(leads, { fields: [appointments.leadId], references: [leads.id] }), patient: one(patients, { fields: [appointments.patientId], references: [patients.id] }), medicalCase: one(medicalCases, { fields: [appointments.medicalCaseId], references: [medicalCases.id] }), participants: many(appointmentParticipants) }));
export const appointmentParticipantRelations = relations(appointmentParticipants, ({ one }) => ({ session: one(appointmentSessions, { fields: [appointmentParticipants.sessionId], references: [appointmentSessions.id] }), appointment: one(appointments, { fields: [appointmentParticipants.appointmentId], references: [appointments.id] }), patient: one(patients, { fields: [appointmentParticipants.patientId], references: [patients.id] }) }));
