import { Client } from "pg";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { loadMigrations, migrate } from "../scripts/migrate";
import { clinicSettings, patients } from "../src/db/schema";
import { loadRequestDatabaseAdapter } from "../src/index";
import { withEmptyTestDatabase } from "./helpers/database";

describe("database foundation", () => {
  test("bootstraps an empty DB, migrates as crm_migrations, enforces roles and preserves clinic-local dates", async () => {
    await withEmptyTestDatabase(async ({ adminUrl, migrationUrl, runtimeUrl }) => {
      await migrate(migrationUrl);
      await migrate(migrationUrl);
      const admin = new Client({ connectionString: adminUrl });
      const runtime = new Client({ connectionString: runtimeUrl });
      await admin.connect();
      await runtime.connect();
      try {
        const roles = await admin.query<{ rolname: string; rolcanlogin: boolean; rolinherit: boolean; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolreplication: boolean; rolbypassrls: boolean }>("SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname IN ('crm_owner', 'crm_migrations', 'crm_runtime') ORDER BY rolname");
        expect(roles.rows).toEqual(expect.arrayContaining([
          expect.objectContaining({ rolname: "crm_owner", rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }),
          expect.objectContaining({ rolname: "crm_migrations", rolcanlogin: true, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }),
          expect.objectContaining({ rolname: "crm_runtime", rolcanlogin: true, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }),
        ]));
        const memberships = await admin.query<{ member: string; parent: string }>("SELECT member.rolname AS member, parent.rolname AS parent FROM pg_auth_members m JOIN pg_roles parent ON parent.oid = m.roleid JOIN pg_roles member ON member.oid = m.member WHERE member.rolname IN ('crm_owner', 'crm_migrations', 'crm_runtime') ORDER BY member, parent");
        expect(memberships.rows).toEqual([{ member: "crm_migrations", parent: "crm_owner" }]);
        await expect(admin.query("SELECT 1 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid = m.roleid JOIN pg_roles member ON member.oid = m.member WHERE parent.rolname = 'crm_owner' AND member.rolname = 'crm_membership_probe'")).resolves.toMatchObject({ rowCount: 0 });
        const journal = await admin.query<{ count: string }>("SELECT count(*) FROM crm_internal.schema_migrations WHERE state = 'applied'");
        expect(journal.rows[0]?.count).toBe(String((await loadMigrations()).length));
        await expect(runtime.query<{ count: string }>("SELECT count(*) FROM crm.roles WHERE system_kind IN ('leader', 'administrator', 'doctor', 'rehabilitologist', 'massage_therapist', 'physiotherapist')")).resolves.toMatchObject({ rows: [{ count: "6" }] });
        await expect(runtime.query("DELETE FROM crm.roles")).rejects.toMatchObject({ code: "42501" });
        await expect(runtime.query("DELETE FROM crm.auth_recovery_challenges")).rejects.toMatchObject({ code: "42501" });

        const createdAt = new Date("2026-01-01T19:30:00.000Z");
        await expect(runtime.query("INSERT INTO crm.clinic_settings (id, clinic_name, timezone, created_at, updated_at) VALUES ($1, 'Invalid', 'Not/A_Timezone', now(), now())", ["00000000-0000-7000-8000-000000000099"])).rejects.toMatchObject({ code: "23514" });
        await expect(runtime.query("INSERT INTO crm.clinic_settings (id, clinic_name, timezone, created_at, updated_at) VALUES ($1, 'Invalid', 'PST', now(), now())", ["00000000-0000-7000-8000-000000000098"])).rejects.toMatchObject({ code: "23514" });
        await expect(runtime.query("INSERT INTO crm.clinic_settings (id, clinic_name, timezone, created_at, updated_at) VALUES ($1, 'Invalid', 'UTC0', now(), now())", ["00000000-0000-7000-8000-000000000097"])).rejects.toMatchObject({ code: "23514" });
        const adapter = await loadRequestDatabaseAdapter();
        await adapter.withRequestDatabase({ connectionString: runtimeUrl }, async (db) => {
          await db.insert(clinicSettings).values({ id: "00000000-0000-7000-8000-000000000001", clinicName: "InMotion", timezone: "Asia/Qyzylorda", createdAt, updatedAt: createdAt });
          await db.insert(patients).values({ id: "00000000-0000-7000-8000-000000000002", familyName: "Test", givenName: "Patient", dateOfBirth: "2000-01-01", phone: "+70000000000", createdAt, updatedAt: createdAt });
          await db.update(patients).set({ updatedAt: new Date("2026-01-01T19:31:00.000Z") }).where(eq(patients.id, "00000000-0000-7000-8000-000000000002"));
        });
        await expect(runtime.query("INSERT INTO crm.clinic_settings (id, clinic_name, timezone, created_at, updated_at) VALUES ($1, 'Second', 'Asia/Qyzylorda', now(), now())", ["00000000-0000-7000-8000-000000000003"])).rejects.toMatchObject({ code: "23505" });
        await runtime.query("UPDATE crm.clinic_settings SET archived_at = now() WHERE id = $1", ["00000000-0000-7000-8000-000000000001"]);
        await expect(runtime.query("INSERT INTO crm.clinic_settings (id, clinic_name, timezone, created_at, updated_at) VALUES ($1, 'Second', 'Asia/Qyzylorda', now(), now())", ["00000000-0000-7000-8000-000000000003"])).resolves.toMatchObject({ rowCount: 1 });
        await runtime.query("INSERT INTO crm.employees (id, full_name, email, recovery_email, created_at, updated_at) VALUES ('00000000-0000-7000-8000-000000000010', 'Test Employee', 'employee@test.invalid', 'employee@test.invalid', now(), now()); INSERT INTO crm.services (id, code, name, delivery_mode, default_duration_minutes, default_price, created_at, updated_at) VALUES ('00000000-0000-7000-8000-000000000011', 'T', 'Test', 'individual', 30, 0, now(), now()); INSERT INTO crm.appointment_sessions (id, service_id, primary_employee_id, starts_at, ends_at, capacity, status, created_at, updated_at) VALUES ('00000000-0000-7000-8000-000000000012', '00000000-0000-7000-8000-000000000011', '00000000-0000-7000-8000-000000000010', now(), now() + interval '30 min', 1, 'scheduled', now(), now()); INSERT INTO crm.leads (id, full_name, phone, status, created_at, updated_at) VALUES ('00000000-0000-7000-8000-000000000013', 'Lead', '+700', 'new', now(), now());");
        await expect(runtime.query("INSERT INTO crm.appointments (id, session_id, lead_id, patient_id, status, created_at, updated_at) VALUES ('00000000-0000-7000-8000-000000000014', '00000000-0000-7000-8000-000000000012', '00000000-0000-7000-8000-000000000013', '00000000-0000-7000-8000-000000000002', 'scheduled', now(), now())")).resolves.toMatchObject({ rowCount: 1 });
        await expect(runtime.query("INSERT INTO crm.appointments (id, session_id, status, created_at, updated_at) VALUES ('00000000-0000-7000-8000-000000000015', '00000000-0000-7000-8000-000000000012', 'scheduled', now(), now())")).rejects.toMatchObject({ code: "23514" });
        const temporal = await runtime.query<{ utc: string; local_date: string }>("SELECT to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SSOF') AS utc, to_char(p.created_at AT TIME ZONE s.timezone, 'YYYY-MM-DD') AS local_date FROM crm.patients p JOIN crm.clinic_settings s ON s.archived_at IS NULL WHERE p.id = $1", ["00000000-0000-7000-8000-000000000002"]);
        expect(temporal.rows[0]?.utc).toBe("2026-01-01 19:30:00+00");
        expect(temporal.rows[0]?.local_date).toBe("2026-01-02");

        await expect(runtime.query("CREATE TABLE crm.runtime_escape (id integer)")).rejects.toMatchObject({ code: "42501" });
        await expect(runtime.query("CREATE SCHEMA runtime_escape")).rejects.toMatchObject({ code: "42501" });
        await expect(runtime.query("CREATE TABLE public.runtime_escape (id integer)")).rejects.toMatchObject({ code: "42501" });
        await expect(runtime.query("TRUNCATE crm.patients")).rejects.toMatchObject({ code: "42501" });
        await expect(runtime.query("DELETE FROM crm.patients")).rejects.toMatchObject({ code: "42501" });
        await expect(runtime.query("SELECT * FROM crm_internal.schema_migrations")).rejects.toMatchObject({ code: "42501" });
        await expect(runtime.query("CREATE TABLE crm_internal.runtime_escape (id integer)")).rejects.toMatchObject({ code: "42501" });
      } finally { await runtime.end(); await admin.end(); }
    });
  }, 90_000);
});
