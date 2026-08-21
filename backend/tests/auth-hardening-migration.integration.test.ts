import { Client } from "pg";
import { describe, expect, test } from "vitest";

import { migrate } from "../scripts/migrate";
import { withEmptyTestDatabase } from "./helpers/database";

describe("auth hardening migration", () => {
  test("converts legacy changing credentials, recovery grants and provider effects", async () => {
    await withEmptyTestDatabase(async ({ adminUrl, migrationUrl }) => {
      await migrate(migrationUrl, { through: "0019_identity_lifecycle_hardening.sql" });
      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        const employeeId = "00000000-0000-7000-8000-000000000201";
        const epochId = "00000000-0000-7000-8000-000000000202";
        const bindingId = "00000000-0000-7000-8000-000000000203";
        const subjectId = "00000000-0000-7000-8000-000000000204";
        await admin.query("INSERT INTO crm.employees (id, full_name, email, recovery_email, created_at, updated_at) VALUES ($1, 'Legacy Security', 'legacy@example.invalid', 'legacy@example.invalid', clock_timestamp(), clock_timestamp())", [employeeId]);
        await admin.query("INSERT INTO crm.employment_epochs (id, employee_id, sequence, state) VALUES ($1, $2, 1, 'provider_creating')", [epochId, employeeId]);
        await admin.query("INSERT INTO crm.employee_security_states (employee_id, employment_epoch_id, access_state, credential_state) VALUES ($1, $2, 'suspended', 'changing')", [employeeId, epochId]);
        await admin.query("INSERT INTO crm.auth_bindings (id, employment_epoch_id, provider_namespace, provider_subject_id, provider_marker, state) VALUES ($1, $2, 'legacy', $3, 'legacy-marker', 'reserved')", [bindingId, epochId, subjectId]);
        await admin.query(`INSERT INTO crm.auth_recovery_challenges (
          id, employee_id, employment_epoch_id, auth_binding_id, state_verifier_hash,
          code_verifier_ciphertext, recovery_grant_hash, state, expires_at, verified_at
        ) VALUES ('00000000-0000-7000-8000-000000000205', $1, $2, $3, 'state-hash', 'ciphertext', 'grant-hash', 'verified', clock_timestamp() + interval '30 minutes', clock_timestamp())`, [employeeId, epochId, bindingId]);
        await admin.query(`INSERT INTO crm.security_outbox (id, operation, aggregate_type, aggregate_id, payload) VALUES
          ('00000000-0000-7000-8000-000000000206', 'provider_user_ban', 'employee', $1, '{}'::jsonb),
          ('00000000-0000-7000-8000-000000000207', 'provider_user_provision', 'employment_epoch', $2, $3::jsonb)`, [employeeId, epochId, JSON.stringify({ subjectId, recoveryEmail: "legacy@example.invalid", marker: "legacy-marker" })]);

        await migrate(migrationUrl);

        await expect(admin.query("SELECT credential_state, credential_operation_id FROM crm.employee_security_states WHERE employee_id = $1", [employeeId])).resolves.toMatchObject({ rows: [{ credential_state: "reconciliation_required", credential_operation_id: null }] });
        await expect(admin.query("SELECT state, recovery_grant_hash, credential_epoch_at_issue FROM crm.auth_recovery_challenges WHERE employee_id = $1", [employeeId])).resolves.toMatchObject({ rows: [{ state: "expired", recovery_grant_hash: null, credential_epoch_at_issue: null }] });
        await expect(admin.query("SELECT operation, state, payload FROM crm.security_outbox ORDER BY operation", [])).resolves.toMatchObject({ rows: [
          { operation: "provider_user_ban", state: "pending", payload: { subjectId } },
          { operation: "provider_user_provision", state: "quarantined" },
        ] });
      } finally {
        await admin.end();
      }
    });
  }, 90_000);
});
