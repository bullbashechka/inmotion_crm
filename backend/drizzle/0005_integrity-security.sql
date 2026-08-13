-- Controlled security for task 003 integrity primitives.
-- Audit rows are append-only to crm_runtime; expiry cleanup is a no-argument,
-- SECURITY DEFINER function so callers cannot select individual rows to delete.
REVOKE ALL ON TABLE crm.audit_entries, crm.audit_retention_policies, crm.idempotency_keys FROM PUBLIC, crm_runtime;
GRANT SELECT, INSERT ON TABLE crm.audit_entries TO crm_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE crm.idempotency_keys TO crm_runtime;
GRANT SELECT ON TABLE crm.audit_retention_policies TO crm_runtime;

CREATE FUNCTION crm.set_audit_retention_policy(
  p_policy_id uuid,
  p_audit_id uuid,
  p_actor_employee_id uuid,
  p_retention_days integer,
  p_reason text,
  p_occurred_at timestamptz
)
RETURNS TABLE (id uuid, retention_days integer, version integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm
AS $$
DECLARE
  current_policy_id uuid;
  previous_retention_days integer;
  previous_version integer;
  current_version integer;
BEGIN
  IF p_retention_days IS NOT NULL AND p_retention_days <= 0 THEN
    RAISE EXCEPTION 'Audit retention days must be positive or null.' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(5139026003);

  SELECT policy.id, policy.retention_days, policy.version
  INTO current_policy_id, previous_retention_days, previous_version
  FROM crm.audit_retention_policies
  AS policy
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO crm.audit_retention_policies (id, retention_days, created_at, updated_at, version)
    VALUES (p_policy_id, p_retention_days, p_occurred_at, p_occurred_at, 1)
    RETURNING crm.audit_retention_policies.version INTO current_version;
    current_policy_id := p_policy_id;
  ELSE
    UPDATE crm.audit_retention_policies AS policy
    SET retention_days = p_retention_days,
        updated_at = p_occurred_at,
        version = policy.version + 1
    WHERE policy.id = current_policy_id
    RETURNING policy.version INTO current_version;
  END IF;

  UPDATE crm.audit_entries AS entry
  SET expires_at = CASE
    WHEN p_retention_days IS NULL THEN NULL
    ELSE entry.occurred_at + (p_retention_days * interval '1 day')
  END
  WHERE entry.expires_at IS NULL OR entry.expires_at > p_occurred_at;

  INSERT INTO crm.audit_entries (
    id, occurred_at, actor_employee_id, action, category, view_scope,
    entity_type, entity_id, reason, before, after, expires_at
  ) VALUES (
    p_audit_id, p_occurred_at, p_actor_employee_id, 'audit_retention_policy.updated',
    'settings', 'settings', 'auditRetentionPolicy', current_policy_id, p_reason,
    CASE WHEN previous_version IS NULL THEN NULL ELSE jsonb_build_object('retentionDays', previous_retention_days, 'version', previous_version) END,
    jsonb_build_object('retentionDays', p_retention_days, 'version', current_version),
    CASE WHEN p_retention_days IS NULL THEN NULL ELSE p_occurred_at + (p_retention_days * interval '1 day') END
  );

  RETURN QUERY
  SELECT policy.id, policy.retention_days, policy.version
  FROM crm.audit_retention_policies AS policy
  WHERE policy.id = current_policy_id;
END;
$$;

CREATE FUNCTION crm.purge_expired_audit_entries()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm
AS $$
DECLARE
  purged_count integer;
BEGIN
  DELETE FROM crm.audit_entries
  WHERE expires_at IS NOT NULL AND expires_at <= clock_timestamp();

  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;

REVOKE ALL ON FUNCTION crm.set_audit_retention_policy(uuid, uuid, uuid, integer, text, timestamptz), crm.purge_expired_audit_entries() FROM PUBLIC, crm_migrations, crm_runtime;
GRANT EXECUTE ON FUNCTION crm.set_audit_retention_policy(uuid, uuid, uuid, integer, text, timestamptz), crm.purge_expired_audit_entries() TO crm_runtime;
