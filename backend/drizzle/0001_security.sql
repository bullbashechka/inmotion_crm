-- Drizzle Kit custom migration: controlled database security and timezone validation.
REVOKE ALL ON SCHEMA crm FROM PUBLIC;
REVOKE ALL ON SCHEMA crm FROM crm_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA crm FROM PUBLIC, crm_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA crm FROM PUBLIC, crm_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crm FROM PUBLIC, crm_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_owner IN SCHEMA crm REVOKE ALL ON TABLES FROM PUBLIC, crm_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_owner IN SCHEMA crm REVOKE ALL ON SEQUENCES FROM PUBLIC, crm_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_owner IN SCHEMA crm REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, crm_runtime;

CREATE FUNCTION crm_internal.is_valid_iana_timezone(value text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM now() AT TIME ZONE value;
  RETURN true;
EXCEPTION WHEN invalid_parameter_value THEN
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION crm_internal.is_valid_iana_timezone(text) FROM PUBLIC, crm_runtime, crm_migrations;
GRANT EXECUTE ON FUNCTION crm_internal.is_valid_iana_timezone(text) TO crm_runtime;
ALTER TABLE crm.clinic_settings ADD CONSTRAINT clinic_settings_timezone_iana CHECK (crm_internal.is_valid_iana_timezone(timezone));

GRANT USAGE ON SCHEMA crm TO crm_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE crm.clinic_settings, crm.employees, crm.leads, crm.patients, crm.medical_cases, crm.services, crm.rooms, crm.appointment_sessions, crm.appointments, crm.appointment_participants TO crm_runtime;
