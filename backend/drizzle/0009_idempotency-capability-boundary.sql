-- Task 003: claims and completion capabilities are private database state.
REVOKE ALL ON TABLE crm.idempotency_keys, crm.idempotency_completion_capabilities FROM PUBLIC, crm_runtime;

CREATE OR REPLACE FUNCTION crm.prepare_idempotency_key_claim()
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
  NEW.claim_expires_at := clock_timestamp() + interval '5 minutes';
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION crm.enforce_idempotency_key_completion()
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
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.claim_expires_at IS DISTINCT FROM OLD.claim_expires_at THEN
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

REVOKE ALL ON FUNCTION crm.complete_idempotency_key(uuid, integer, jsonb) FROM PUBLIC, crm_migrations, crm_runtime;
DROP FUNCTION crm.complete_idempotency_key(uuid, integer, jsonb);

CREATE FUNCTION crm.claim_idempotency_key(
  p_id uuid,
  p_scope text,
  p_operation text,
  p_key text,
  p_request_fingerprint text,
  p_completion_capability text
)
RETURNS TABLE (claim_status text, id uuid, response_status integer, response jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm
AS $$
DECLARE
  claimed_id uuid;
  existing_record record;
BEGIN
  IF p_completion_capability !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'The idempotency completion capability is invalid.' USING ERRCODE = '22023';
  END IF;

  LOOP
    INSERT INTO crm.idempotency_keys (id, scope, operation, key, request_fingerprint)
    VALUES (p_id, p_scope, p_operation, p_key, p_request_fingerprint)
    ON CONFLICT (scope, operation, key) DO NOTHING
    RETURNING crm.idempotency_keys.id INTO claimed_id;

    IF FOUND THEN
      INSERT INTO crm.idempotency_completion_capabilities (idempotency_key_id, capability)
      VALUES (claimed_id, p_completion_capability);
      RETURN QUERY SELECT 'claimed'::text, claimed_id, NULL::integer, NULL::jsonb;
      RETURN;
    END IF;

    SELECT record.id, record.request_fingerprint, record.state, record.response_status, record.response, record.claim_expires_at
    INTO existing_record
    FROM crm.idempotency_keys AS record
    WHERE record.scope = p_scope AND record.operation = p_operation AND record.key = p_key
    FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF existing_record.request_fingerprint <> p_request_fingerprint THEN
      RETURN QUERY SELECT 'conflict'::text, existing_record.id, NULL::integer, NULL::jsonb;
      RETURN;
    END IF;

    IF existing_record.state = 'completed' THEN
      RETURN QUERY SELECT 'completed'::text, existing_record.id, existing_record.response_status, existing_record.response;
      RETURN;
    END IF;

    IF existing_record.claim_expires_at <= clock_timestamp() THEN
      DELETE FROM crm.idempotency_keys AS record
      WHERE record.id = existing_record.id
        AND record.state = 'pending'
        AND record.claim_expires_at <= clock_timestamp();
      CONTINUE;
    END IF;

    RETURN QUERY SELECT 'pending'::text, existing_record.id, NULL::integer, NULL::jsonb;
    RETURN;
  END LOOP;
END;
$$;

CREATE FUNCTION crm.complete_idempotency_key(
  p_id uuid,
  p_scope text,
  p_operation text,
  p_key text,
  p_request_fingerprint text,
  p_completion_capability text,
  p_response_status integer,
  p_response jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, crm
AS $$
DECLARE
  completed_id uuid;
BEGIN
  IF p_completion_capability !~ '^[0-9a-f]{64}$'
    OR p_response_status NOT BETWEEN 100 AND 599
    OR p_response IS NULL THEN
    RAISE EXCEPTION 'A completed idempotency key requires a valid capability and terminal response.' USING ERRCODE = '22023';
  END IF;

  UPDATE crm.idempotency_keys AS record
  SET state = 'completed',
      response_status = p_response_status,
      response = p_response
  FROM crm.idempotency_completion_capabilities AS capability
  WHERE record.id = p_id
    AND record.scope = p_scope
    AND record.operation = p_operation
    AND record.key = p_key
    AND record.request_fingerprint = p_request_fingerprint
    AND record.state = 'pending'
    AND record.claim_expires_at > clock_timestamp()
    AND capability.idempotency_key_id = record.id
    AND capability.capability = p_completion_capability
  RETURNING record.id INTO completed_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Idempotency claim capability is invalid or no longer pending.' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM crm.idempotency_completion_capabilities
  WHERE idempotency_key_id = completed_id;
END;
$$;

REVOKE ALL ON FUNCTION crm.prepare_idempotency_key_claim(), crm.enforce_idempotency_key_completion(), crm.claim_idempotency_key(uuid, text, text, text, text, text), crm.complete_idempotency_key(uuid, text, text, text, text, text, integer, jsonb) FROM PUBLIC, crm_migrations, crm_runtime;
GRANT EXECUTE ON FUNCTION crm.claim_idempotency_key(uuid, text, text, text, text, text), crm.complete_idempotency_key(uuid, text, text, text, text, text, integer, jsonb) TO crm_runtime;
