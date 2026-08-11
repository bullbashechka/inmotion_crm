import { Client } from "pg";
import { describe, expect, test } from "vitest";

import { migrate } from "../scripts/migrate";
import { withEmptyTestDatabase } from "./helpers/database";

async function expectPlan(client: Client, query: string, value: string, indexName: string): Promise<void> {
  const result = await client.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (FORMAT JSON) ${query}`, [value]);
  expect(JSON.stringify(result.rows[0]?.["QUERY PLAN"])).toContain(indexName);
}

describe("database foundation performance evidence", () => {
  test("uses selective indexes after 50k patients and 500k distributed appointments", async () => {
    await withEmptyTestDatabase(async ({ migrationUrl, runtimeUrl }) => {
      await migrate(migrationUrl);
      const client = new Client({ connectionString: runtimeUrl });
      await client.connect();
      try {
        await client.query(`
          INSERT INTO crm.employees (id, full_name, email, created_at, updated_at) SELECT md5('employee-' || n)::uuid, 'Employee ' || n, 'employee' || n || '@example.test', now(), now() FROM generate_series(1, 100) n;
          INSERT INTO crm.services (id, code, name, delivery_mode, default_duration_minutes, default_price, created_at, updated_at) VALUES ('00000000-0000-7000-8000-000000000001', 'PERF', 'Performance', 'individual', 30, 0, now(), now());
          INSERT INTO crm.rooms (id, code, name, capacity, created_at, updated_at) SELECT md5('room-' || n)::uuid, 'R' || n, 'Room ' || n, 4, now(), now() FROM generate_series(1, 20) n;
          INSERT INTO crm.patients (id, family_name, given_name, phone, created_at, updated_at) SELECT md5('patient-' || n)::uuid, 'Family' || n, 'Given' || n, '+7000' || lpad(n::text, 7, '0'), now(), now() FROM generate_series(1, 50000) n;
          INSERT INTO crm.appointment_sessions (id, service_id, primary_employee_id, room_id, starts_at, ends_at, capacity, status, created_at, updated_at) SELECT md5('session-' || n)::uuid, '00000000-0000-7000-8000-000000000001', md5('employee-' || ((n - 1) % 100 + 1))::uuid, md5('room-' || ((n - 1) % 20 + 1))::uuid, timestamp '2026-01-01 00:00:00+00' + n * interval '30 minutes', timestamp '2026-01-01 00:00:00+00' + (n + 1) * interval '30 minutes', 4, CASE WHEN n % 2 = 0 THEN 'scheduled' ELSE 'confirmed' END, now(), now() FROM generate_series(1, 50000) n;
          INSERT INTO crm.appointments (id, session_id, patient_id, status, created_at, updated_at) SELECT md5('appointment-' || n)::uuid, md5('session-' || ((n - 1) % 50000 + 1))::uuid, md5('patient-' || ((n - 1) % 50000 + 1))::uuid, 'scheduled', now(), now() FROM generate_series(1, 500000) n;
          ANALYZE crm.patients; ANALYZE crm.appointment_sessions; ANALYZE crm.appointments;
        `);
        await expectPlan(client, "SELECT id FROM crm.patients WHERE family_name = $1 AND archived_at IS NULL", "Family123", "patients_name_active_idx");
        await expectPlan(client, "SELECT id FROM crm.patients WHERE phone = $1 AND archived_at IS NULL", "+70000000123", "patients_phone_active_idx");
        await expectPlan(client, "SELECT id FROM crm.appointments WHERE patient_id = $1", "f98c4f1a-37f4-2892-488a-8ec31e4d3d6e", "appointments_patient_idx");
        await expectPlan(client, "SELECT id FROM crm.appointment_sessions WHERE primary_employee_id = $1 AND starts_at >= '2026-01-02' AND starts_at < '2026-01-03' AND archived_at IS NULL", "6ea9ea79-9e7f-6c2c-62a5-d8a9ef2fc45c", "appointment_sessions_employee_starts_idx");
        await expectPlan(client, "SELECT id FROM crm.appointment_sessions WHERE room_id = $1 AND starts_at >= '2026-01-02' AND starts_at < '2026-01-03' AND archived_at IS NULL", "4ec1f0a8-455f-1002-d79f-1d5398f68d52", "appointment_sessions_room_starts_idx");
        await expectPlan(client, "SELECT id FROM crm.appointment_sessions WHERE status = $1 AND starts_at >= '2026-01-02' AND starts_at < '2026-01-03' AND archived_at IS NULL", "scheduled", "appointment_sessions_status_starts_idx");
      } finally { await client.end(); }
    });
  }, 240_000);
});
