-- Run once as a PostgreSQL administrator before `bun run db:migrate`.
-- Passwords are intentionally not stored here.
DO $$
DECLARE
  membership record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_owner') THEN
    CREATE ROLE crm_owner;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_migrations') THEN
    CREATE ROLE crm_migrations;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_runtime') THEN
    CREATE ROLE crm_runtime;
  END IF;

  FOR membership IN
    SELECT parent.rolname AS parent_role, member.rolname AS member_role
    FROM pg_auth_members membership_map
    JOIN pg_roles parent ON parent.oid = membership_map.roleid
    JOIN pg_roles member ON member.oid = membership_map.member
    WHERE member.rolname IN ('crm_owner', 'crm_migrations', 'crm_runtime')
  LOOP
    EXECUTE format('REVOKE %I FROM %I', membership.parent_role, membership.member_role);
  END LOOP;

  FOR membership IN
    SELECT member.rolname AS member_role
    FROM pg_auth_members membership_map
    JOIN pg_roles parent ON parent.oid = membership_map.roleid
    JOIN pg_roles member ON member.oid = membership_map.member
    WHERE parent.rolname = 'crm_owner' AND member.rolname <> 'crm_migrations'
  LOOP
    EXECUTE format('REVOKE crm_owner FROM %I', membership.member_role);
  END LOOP;
END
$$;

ALTER ROLE crm_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE crm_migrations LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE crm_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE crm_owner SET TimeZone TO 'UTC';
ALTER ROLE crm_migrations SET TimeZone TO 'UTC';
ALTER ROLE crm_runtime SET TimeZone TO 'UTC';
GRANT crm_owner TO crm_migrations;

CREATE SCHEMA IF NOT EXISTS crm_internal AUTHORIZATION crm_owner;
REVOKE ALL ON SCHEMA crm_internal FROM PUBLIC, crm_runtime, crm_migrations;
SET ROLE crm_owner;
CREATE TABLE IF NOT EXISTS crm_internal.schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL,
  state text NOT NULL CHECK (state IN ('running', 'applied')),
  started_at timestamptz NOT NULL,
  applied_at timestamptz
);
REVOKE ALL ON crm_internal.schema_migrations FROM PUBLIC, crm_runtime, crm_migrations;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_owner IN SCHEMA crm_internal REVOKE ALL ON TABLES FROM PUBLIC, crm_runtime, crm_migrations;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_owner IN SCHEMA crm_internal REVOKE ALL ON SEQUENCES FROM PUBLIC, crm_runtime, crm_migrations;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_owner IN SCHEMA crm_internal REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, crm_runtime, crm_migrations;
RESET ROLE;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM crm_owner, crm_migrations, crm_runtime;
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM crm_owner, crm_migrations, crm_runtime', current_database());
  EXECUTE format('GRANT CREATE ON DATABASE %I TO crm_owner', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO crm_migrations, crm_runtime', current_database());
END
$$;
