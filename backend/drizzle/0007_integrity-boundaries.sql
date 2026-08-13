-- Task 003 hardening: clock and state transitions are owned by PostgreSQL.
REVOKE ALL ON FUNCTION crm.set_audit_retention_policy(uuid, uuid, uuid, integer, text, timestamptz) FROM PUBLIC, crm_migrations, crm_runtime;
DROP FUNCTION crm.set_audit_retention_policy(uuid, uuid, uuid, integer, text, timestamptz);

CREATE FUNCTION crm.prepare_audit_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm
AS $$
DECLARE
  configured_retention_days integer;
BEGIN
  IF NEW.reason IS NULL OR btrim(NEW.reason) = '' THEN
    RAISE EXCEPTION 'A critical audit entry requires a non-blank reason.' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(5139026003);
  SELECT policy.retention_days
  INTO configured_retention_days
  FROM crm.audit_retention_policies AS policy
  LIMIT 1;

  NEW.occurred_at := clock_timestamp();
  NEW.expires_at := CASE
    WHEN configured_retention_days IS NULL THEN NULL
    ELSE NEW.occurred_at + (configured_retention_days * interval '1 day')
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_entries_prepare_before_insert
BEFORE INSERT ON crm.audit_entries
FOR EACH ROW EXECUTE FUNCTION crm.prepare_audit_entry();

CREATE FUNCTION crm.prepare_idempotency_key_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm
AS $$
BEGIN
  IF NEW.state <> 'pending'
    OR NEW.response_status IS NOT NULL
    OR NEW.response IS NOT NULL
    OR NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'An idempotency key must be claimed as a pending command without a result.' USING ERRCODE = '23514';
  END IF;

  NEW.created_at := clock_timestamp();
  NEW.completed_at := NULL;
  RETURN NEW;
END;
$$;

CREATE FUNCTION crm.enforce_idempotency_key_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.scope IS DISTINCT FROM OLD.scope
    OR NEW.operation IS DISTINCT FROM OLD.operation
    OR NEW.key IS DISTINCT FROM OLD.key
    OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Idempotency command identity is immutable.' USING ERRCODE = '23514';
  END IF;

  IF OLD.state <> 'pending'
    OR NEW.state <> 'completed'
    OR NEW.response_status IS NULL
    OR NEW.response IS NULL THEN
    RAISE EXCEPTION 'An idempotency key may transition only once from pending to completed with a terminal response.' USING ERRCODE = '23514';
  END IF;

  NEW.completed_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER idempotency_keys_prepare_before_insert
BEFORE INSERT ON crm.idempotency_keys
FOR EACH ROW EXECUTE FUNCTION crm.prepare_idempotency_key_claim();

CREATE TRIGGER idempotency_keys_enforce_before_update
BEFORE UPDATE ON crm.idempotency_keys
FOR EACH ROW EXECUTE FUNCTION crm.enforce_idempotency_key_completion();

REVOKE UPDATE ON TABLE crm.idempotency_keys FROM crm_runtime;

CREATE FUNCTION crm.complete_idempotency_key(
  p_id uuid,
  p_response_status integer,
  p_response jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm
AS $$
BEGIN
  IF p_response_status NOT BETWEEN 100 AND 599 OR p_response IS NULL THEN
    RAISE EXCEPTION 'A completed idempotency key requires a valid terminal response.' USING ERRCODE = '22023';
  END IF;

  UPDATE crm.idempotency_keys AS record
  SET state = 'completed',
      response_status = p_response_status,
      response = p_response
  WHERE record.id = p_id AND record.state = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Idempotency key is not pending.' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE FUNCTION crm.set_audit_retention_policy(
  p_policy_id uuid,
  p_audit_id uuid,
  p_actor_employee_id uuid,
  p_retention_days integer,
  p_reason text,
  p_expected_version integer
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
  changed_at timestamptz := clock_timestamp();
BEGIN
  IF p_retention_days IS NOT NULL AND p_retention_days <= 0 THEN
    RAISE EXCEPTION 'Audit retention days must be positive or null.' USING ERRCODE = '22023';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A retention policy change requires a non-blank reason.' USING ERRCODE = '23514';
  END IF;

  IF p_expected_version IS NULL OR p_expected_version < 0 THEN
    RAISE EXCEPTION 'expectedVersion must be a non-negative integer.' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(5139026003);
  SELECT policy.id, policy.retention_days, policy.version
  INTO current_policy_id, previous_retention_days, previous_version
  FROM crm.audit_retention_policies AS policy
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    IF p_expected_version <> 0 THEN
      RAISE EXCEPTION 'Audit retention policy version conflict.' USING ERRCODE = '40001';
    END IF;
    INSERT INTO crm.audit_retention_policies (id, retention_days, created_at, updated_at, version)
    VALUES (p_policy_id, p_retention_days, changed_at, changed_at, 1)
    RETURNING crm.audit_retention_policies.version INTO current_version;
    current_policy_id := p_policy_id;
  ELSE
    IF p_expected_version <> previous_version THEN
      RAISE EXCEPTION 'Audit retention policy version conflict.' USING ERRCODE = '40001';
    END IF;
    UPDATE crm.audit_retention_policies AS policy
    SET retention_days = p_retention_days,
        updated_at = changed_at,
        version = policy.version + 1
    WHERE policy.id = current_policy_id
    RETURNING policy.version INTO current_version;
  END IF;

  UPDATE crm.audit_entries AS entry
  SET expires_at = CASE
    WHEN p_retention_days IS NULL THEN NULL
    ELSE entry.occurred_at + (p_retention_days * interval '1 day')
  END
  WHERE entry.expires_at IS NULL OR entry.expires_at > changed_at;

  INSERT INTO crm.audit_entries (
    id, actor_employee_id, action, category, view_scope,
    entity_type, entity_id, reason, before, after
  ) VALUES (
    p_audit_id, p_actor_employee_id, 'audit_retention_policy.updated',
    'settings', 'settings', 'auditRetentionPolicy', current_policy_id, p_reason,
    CASE WHEN previous_version IS NULL THEN NULL ELSE jsonb_build_object('retentionDays', previous_retention_days, 'version', previous_version) END,
    jsonb_build_object('retentionDays', p_retention_days, 'version', current_version)
  );

  RETURN QUERY
  SELECT policy.id, policy.retention_days, policy.version
  FROM crm.audit_retention_policies AS policy
  WHERE policy.id = current_policy_id;
END;
$$;

REVOKE ALL ON FUNCTION crm.prepare_audit_entry(), crm.prepare_idempotency_key_claim(), crm.enforce_idempotency_key_completion(), crm.complete_idempotency_key(uuid, integer, jsonb), crm.set_audit_retention_policy(uuid, uuid, uuid, integer, text, integer) FROM PUBLIC, crm_migrations, crm_runtime;
GRANT EXECUTE ON FUNCTION crm.complete_idempotency_key(uuid, integer, jsonb), crm.set_audit_retention_policy(uuid, uuid, uuid, integer, text, integer) TO crm_runtime;
