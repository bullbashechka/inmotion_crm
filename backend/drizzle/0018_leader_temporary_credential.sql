CREATE OR REPLACE FUNCTION crm.is_eligible_leader()
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
      AND security.credential_state IN ('temporary_password', 'ready', 'password_change_required')
      AND epoch.state = 'active'
      AND role.system_kind = 'leader'
  );
$$;

REVOKE ALL ON FUNCTION crm.is_eligible_leader() FROM PUBLIC, crm_migrations, crm_runtime;
GRANT EXECUTE ON FUNCTION crm.is_eligible_leader() TO crm_runtime;
