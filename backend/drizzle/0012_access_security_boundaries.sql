-- Task 004: runtime access is limited to the access-control tables and all
-- leader-sensitive invariants have a durable clinic-wide serialization anchor.

REVOKE ALL ON TABLE
  crm.clinic_security_states,
  crm.employment_epochs,
  crm.employee_security_states,
  crm.login_claims,
  crm.auth_bindings,
  crm.permission_catalog,
  crm.roles,
  crm.role_revisions,
  crm.role_grants,
  crm.role_assignments,
  crm.employee_permission_overrides,
  crm.crm_sessions,
  crm.security_outbox
FROM PUBLIC, crm_runtime;

GRANT SELECT, INSERT, UPDATE ON TABLE
  crm.clinic_security_states,
  crm.employment_epochs,
  crm.employee_security_states,
  crm.login_claims,
  crm.auth_bindings,
  crm.permission_catalog,
  crm.roles,
  crm.role_revisions,
  crm.role_grants,
  crm.role_assignments,
  crm.employee_permission_overrides,
  crm.crm_sessions,
  crm.security_outbox
TO crm_runtime;

CREATE FUNCTION crm.is_eligible_leader()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, crm
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM crm.employee_security_states AS security
    JOIN crm.employment_epochs AS epoch
      ON epoch.id = security.employment_epoch_id
     AND epoch.employee_id = security.employee_id
    JOIN crm.role_assignments AS assignment
      ON assignment.employment_epoch_id = epoch.id
     AND assignment.employee_id = security.employee_id
     AND assignment.revoked_at IS NULL
    JOIN crm.roles AS role
      ON role.id = assignment.role_id
     AND role.archived_at IS NULL
    JOIN crm.auth_bindings AS binding
      ON binding.employment_epoch_id = epoch.id
     AND binding.state = 'active'
    WHERE security.access_state = 'active'
      AND security.credential_state IN ('ready', 'password_change_required')
      AND epoch.state = 'active'
      AND role.system_kind = 'leader'
  );
$$;

REVOKE ALL ON FUNCTION crm.is_eligible_leader() FROM PUBLIC, crm_migrations, crm_runtime;
GRANT EXECUTE ON FUNCTION crm.is_eligible_leader() TO crm_runtime;
