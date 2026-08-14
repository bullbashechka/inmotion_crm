-- Task 004: make the CRM login independent from the provider email and retain
-- enough lifecycle state to recover safely from interrupted employee changes.

ALTER TABLE crm.employees ADD COLUMN recovery_email text;
UPDATE crm.employees
SET recovery_email = lower(COALESCE(contact_email, email))
WHERE recovery_email IS NULL;
ALTER TABLE crm.employees ALTER COLUMN recovery_email SET NOT NULL;
CREATE UNIQUE INDEX employees_recovery_email_unique ON crm.employees (lower(recovery_email));
ALTER TABLE crm.employees
  ADD CONSTRAINT employees_recovery_email_not_blank CHECK (btrim(recovery_email) <> '');

ALTER TABLE crm.login_claims ADD COLUMN employee_id uuid;
UPDATE crm.login_claims AS claim
SET employee_id = epoch.employee_id
FROM crm.employment_epochs AS epoch
WHERE epoch.id = claim.employment_epoch_id
  AND claim.employee_id IS NULL;
ALTER TABLE crm.login_claims ALTER COLUMN employee_id SET NOT NULL;
ALTER TABLE crm.login_claims
  ADD CONSTRAINT login_claims_employee_id_employees_id_fk
  FOREIGN KEY (employee_id) REFERENCES crm.employees(id) ON DELETE RESTRICT;

-- Existing task-004 development identities used an email-shaped login. Give
-- each one a deterministic username before enforcing the new product rule.
UPDATE crm.login_claims AS claim
SET canonical_login = left(
  CASE
    WHEN length(btrim(regexp_replace(split_part(lower(claim.canonical_login), '@', 1), '[^a-z0-9._-]+', '-', 'g'), '._-')) >= 3
      THEN btrim(regexp_replace(split_part(lower(claim.canonical_login), '@', 1), '[^a-z0-9._-]+', '-', 'g'), '._-')
    ELSE 'user'
  END,
  54
) || '-' || left(claim.employee_id::text, 8)
WHERE claim.canonical_login LIKE '%@%';
ALTER TABLE crm.login_claims
  ADD CONSTRAINT login_claims_username_format
  CHECK (canonical_login ~ '^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])?$');

ALTER TABLE crm.auth_bindings DROP CONSTRAINT auth_bindings_provider_subject_unique;
CREATE UNIQUE INDEX auth_bindings_one_current_provider_subject_unique
  ON crm.auth_bindings (provider_namespace, provider_subject_id)
  WHERE state IN ('reserved', 'confirmed', 'active');

ALTER TABLE crm.employee_security_states
  ADD COLUMN temporary_password_expires_at timestamp with time zone,
  ADD COLUMN login_failure_window_started_at timestamp with time zone;
ALTER TABLE crm.employee_security_states
  ADD CONSTRAINT employee_security_states_temporary_password_expiry_valid
  CHECK ((credential_state = 'temporary_password' AND temporary_password_expires_at IS NOT NULL) OR credential_state <> 'temporary_password');

ALTER TABLE crm.employee_permission_overrides
  ADD COLUMN expires_at timestamp with time zone;
ALTER TABLE crm.employee_permission_overrides
  ADD CONSTRAINT employee_permission_overrides_expiry_valid
  CHECK (expires_at IS NULL OR expires_at > created_at);

ALTER TABLE crm.audit_entries ADD COLUMN reason_code text;

CREATE TABLE crm.unassigned_responsibilities (
  id uuid PRIMARY KEY NOT NULL,
  category_code text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  previous_employee_id uuid NOT NULL REFERENCES crm.employees(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  resolved_at timestamp with time zone,
  resolved_by_employee_id uuid REFERENCES crm.employees(id) ON DELETE RESTRICT,
  CONSTRAINT unassigned_responsibilities_category_not_blank CHECK (btrim(category_code) <> ''),
  CONSTRAINT unassigned_responsibilities_entity_type_not_blank CHECK (btrim(entity_type) <> ''),
  CONSTRAINT unassigned_responsibilities_reason_not_blank CHECK (btrim(reason) <> '')
);
CREATE UNIQUE INDEX unassigned_responsibilities_open_entity_unique
  ON crm.unassigned_responsibilities (category_code, entity_type, entity_id)
  WHERE resolved_at IS NULL;
CREATE INDEX unassigned_responsibilities_open_queue_idx
  ON crm.unassigned_responsibilities (category_code, created_at)
  WHERE resolved_at IS NULL;

REVOKE ALL ON TABLE crm.unassigned_responsibilities FROM PUBLIC, crm_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE crm.unassigned_responsibilities TO crm_runtime;
