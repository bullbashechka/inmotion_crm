-- Task 004: database-enforced safety boundaries for the security model.

REVOKE ALL ON TABLE crm.auth_login_attempts FROM PUBLIC, crm_runtime;
GRANT SELECT, INSERT ON TABLE crm.auth_login_attempts TO crm_runtime;

CREATE FUNCTION crm.enforce_active_leader_invariant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm
AS $$
BEGIN
  -- Before bootstrap there cannot be a leader yet. Once the security model is
  -- explicitly initialized, every committed state must retain one usable one.
  IF NOT EXISTS (
    SELECT 1
    FROM crm.clinic_security_states
    WHERE security_initialized_at IS NOT NULL
  ) THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(5139026004);

  IF NOT crm.is_eligible_leader() THEN
    RAISE EXCEPTION 'At least one active leader with a usable identity is required.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER role_assignments_require_active_leader
AFTER INSERT OR UPDATE OR DELETE ON crm.role_assignments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm.enforce_active_leader_invariant();

CREATE CONSTRAINT TRIGGER employee_security_states_require_active_leader
AFTER INSERT OR UPDATE OR DELETE ON crm.employee_security_states
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm.enforce_active_leader_invariant();

CREATE CONSTRAINT TRIGGER employment_epochs_require_active_leader
AFTER INSERT OR UPDATE OR DELETE ON crm.employment_epochs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm.enforce_active_leader_invariant();

CREATE CONSTRAINT TRIGGER auth_bindings_require_active_leader
AFTER INSERT OR UPDATE OR DELETE ON crm.auth_bindings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm.enforce_active_leader_invariant();

CREATE CONSTRAINT TRIGGER roles_require_active_leader
AFTER INSERT OR UPDATE OR DELETE ON crm.roles
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm.enforce_active_leader_invariant();

CREATE CONSTRAINT TRIGGER clinic_security_states_require_active_leader
AFTER INSERT OR UPDATE OR DELETE ON crm.clinic_security_states
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm.enforce_active_leader_invariant();

REVOKE ALL ON FUNCTION crm.enforce_active_leader_invariant() FROM PUBLIC, crm_migrations, crm_runtime;
