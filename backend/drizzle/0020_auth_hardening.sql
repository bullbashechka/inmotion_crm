-- Security hardening: reserve login attempts before provider authentication and
-- make recovery grants single-consumer server-side capabilities.

ALTER TABLE crm.employee_security_states
  ADD COLUMN credential_operation_id uuid;
UPDATE crm.employee_security_states
SET credential_state = 'reconciliation_required', session_epoch = session_epoch + 1,
    updated_at = clock_timestamp(), version = version + 1
WHERE credential_state = 'changing';
ALTER TABLE crm.employee_security_states
  ADD CONSTRAINT employee_security_states_credential_operation_valid
  CHECK ((credential_state = 'changing') = (credential_operation_id IS NOT NULL));

ALTER TABLE crm.auth_login_attempts
  DROP CONSTRAINT auth_login_attempts_outcome_valid;
ALTER TABLE crm.auth_login_attempts
  ADD CONSTRAINT auth_login_attempts_outcome_valid
  CHECK (outcome IN ('processing', 'succeeded', 'invalid_credentials', 'locked', 'inactive', 'provider_unavailable', 'reconciliation_required'));
REVOKE ALL ON TABLE crm.auth_login_attempts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE crm.auth_login_attempts TO crm_runtime;
CREATE INDEX auth_login_attempts_processing_lease_idx
  ON crm.auth_login_attempts (occurred_at)
  WHERE outcome = 'processing';

ALTER TABLE crm.auth_recovery_challenges
  ADD COLUMN grant_expires_at timestamp with time zone,
  ADD COLUMN credential_epoch_at_issue integer;
UPDATE crm.auth_recovery_challenges
SET state = 'expired', recovery_grant_hash = NULL
WHERE state IN ('pending', 'verified');
ALTER TABLE crm.auth_recovery_challenges
  ADD CONSTRAINT auth_recovery_challenges_credential_epoch_positive
  CHECK (credential_epoch_at_issue IS NULL OR credential_epoch_at_issue > 0);
ALTER TABLE crm.auth_recovery_challenges
  DROP CONSTRAINT auth_recovery_challenges_state_valid;
ALTER TABLE crm.auth_recovery_challenges
  ADD CONSTRAINT auth_recovery_challenges_state_valid
  CHECK (state IN ('pending', 'verified', 'consuming', 'consumed', 'expired', 'quarantined'));
ALTER TABLE crm.auth_recovery_challenges
  DROP CONSTRAINT auth_recovery_challenges_grant_state_valid;
ALTER TABLE crm.auth_recovery_challenges
  ADD CONSTRAINT auth_recovery_challenges_grant_state_valid
  CHECK (
    (state = 'verified' AND recovery_grant_hash IS NOT NULL AND verified_at IS NOT NULL AND grant_expires_at IS NOT NULL)
    OR (state <> 'verified' AND recovery_grant_hash IS NULL)
  );
DROP INDEX crm.auth_recovery_challenges_one_active_per_employee_unique;
CREATE UNIQUE INDEX auth_recovery_challenges_one_active_per_employee_unique
  ON crm.auth_recovery_challenges (employee_id)
  WHERE state = 'pending';
CREATE INDEX auth_recovery_challenges_employee_created_idx
  ON crm.auth_recovery_challenges (employee_id, created_at);

CREATE TABLE crm.crm_refresh_token_replays (
  refresh_token_hash text PRIMARY KEY NOT NULL,
  session_id uuid NOT NULL REFERENCES crm.crm_sessions(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  successor_ciphertext text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT crm_refresh_token_replays_hash_not_blank CHECK (btrim(refresh_token_hash) <> ''),
  CONSTRAINT crm_refresh_token_replays_successor_ciphertext_not_blank CHECK (btrim(successor_ciphertext) <> '')
);
CREATE INDEX crm_refresh_token_replays_expiry_idx ON crm.crm_refresh_token_replays (expires_at);
REVOKE ALL ON TABLE crm.crm_refresh_token_replays FROM PUBLIC, crm_runtime;
GRANT SELECT, INSERT ON TABLE crm.crm_refresh_token_replays TO crm_runtime;

-- Older lifecycle effects did not carry a replayable credential secret. They
-- must become explicit operator work instead of remaining pending forever.
WITH latest_binding AS (
  SELECT DISTINCT ON (epoch.employee_id) epoch.employee_id, auth_binding.provider_subject_id
  FROM crm.employment_epochs AS epoch
  JOIN crm.auth_bindings AS auth_binding ON auth_binding.employment_epoch_id = epoch.id
  ORDER BY epoch.employee_id, epoch.sequence DESC
)
UPDATE crm.security_outbox AS effect
SET payload = jsonb_build_object('subjectId', latest_binding.provider_subject_id::text)
FROM latest_binding
WHERE effect.operation = 'provider_user_ban'
  AND effect.aggregate_type = 'employee'
  AND effect.aggregate_id = latest_binding.employee_id
  AND NOT (effect.payload ? 'subjectId');
UPDATE crm.security_outbox
SET state = 'quarantined'
WHERE operation IN ('provider_user_provision', 'provider_user_restore')
  AND state IN ('pending', 'processing')
  AND NOT (payload ? 'passwordCiphertext');
UPDATE crm.security_outbox
SET payload = '{}'::jsonb
WHERE state = 'completed'
  AND aggregate_type IN ('auth_provider_effect', 'employment_epoch');
