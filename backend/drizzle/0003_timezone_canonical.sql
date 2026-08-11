-- Drizzle Kit custom migration: canonical IANA timezone names only.
ALTER TABLE crm.clinic_settings DROP CONSTRAINT clinic_settings_timezone_iana;
REVOKE ALL ON FUNCTION crm_internal.is_valid_iana_timezone(text) FROM PUBLIC, crm_runtime, crm_migrations;
DROP FUNCTION crm_internal.is_valid_iana_timezone(text);
CREATE FUNCTION crm.is_valid_iana_timezone(value text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$ SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = value) $$;
REVOKE ALL ON FUNCTION crm.is_valid_iana_timezone(text) FROM PUBLIC, crm_runtime, crm_migrations;
GRANT EXECUTE ON FUNCTION crm.is_valid_iana_timezone(text) TO crm_runtime;
ALTER TABLE crm.clinic_settings ADD CONSTRAINT clinic_settings_timezone_iana CHECK (crm.is_valid_iana_timezone(timezone));
