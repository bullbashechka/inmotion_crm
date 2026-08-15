-- Task 004: a closed initial permission catalog and immutable identifiers for
-- the six product roles. Changes to their grants are published as new revisions
-- by the application, never inferred from a provider claim.

INSERT INTO crm.permission_catalog (code, resource_family, is_sensitive, is_governance) VALUES
  ('employees.manage', 'employees', 0, 1),
  ('employees.unlock', 'employees', 0, 1),
  ('employees.offboard', 'employees', 1, 1),
  ('roles.assign', 'roles', 0, 1),
  ('roles.manage', 'roles', 1, 1),
  ('permissions.grant', 'roles', 1, 1),
  ('contacts.read', 'patients', 0, 0),
  ('schedule.read', 'schedule', 0, 0),
  ('schedule.manage', 'schedule', 0, 0),
  ('payments.read', 'financial', 1, 0),
  ('payments.manage', 'financial', 1, 0),
  ('medical.read.assigned', 'medical', 1, 0),
  ('medical.write.assigned', 'medical', 1, 0),
  ('medical.read.all', 'medical', 1, 0),
  ('medical.write.all', 'medical', 1, 0),
  ('medical.export', 'medical', 1, 0),
  ('financial.export', 'financial', 1, 0),
  ('audit.read', 'audit', 1, 0)
ON CONFLICT (code) DO NOTHING;

INSERT INTO crm.roles (id, code, system_kind, admin_assignable, authorization_revision)
VALUES
  ('00000000-0000-7000-8000-000000000401', 'leader', 'leader', 0, 1),
  ('00000000-0000-7000-8000-000000000402', 'administrator', 'administrator', 1, 1),
  ('00000000-0000-7000-8000-000000000403', 'doctor', 'doctor', 1, 1),
  ('00000000-0000-7000-8000-000000000404', 'rehabilitologist', 'rehabilitologist', 1, 1),
  ('00000000-0000-7000-8000-000000000405', 'massage_therapist', 'massage_therapist', 1, 1),
  ('00000000-0000-7000-8000-000000000406', 'physiotherapist', 'physiotherapist', 1, 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO crm.role_revisions (id, role_id, revision, reason, capability_hash)
VALUES
  ('00000000-0000-7000-8000-000000000411', '00000000-0000-7000-8000-000000000401', 1, 'initial product role', 'e67151e5075e70dcc64e1e5afe89d0ca2ba1d9e6fa7162820486ac806b9cb19e'),
  ('00000000-0000-7000-8000-000000000412', '00000000-0000-7000-8000-000000000402', 1, 'initial product role', '5f1a9c8d2ee2d2c04222ab4aed5bb0d40cdde2e4f9e464147f958c1170369195'),
  ('00000000-0000-7000-8000-000000000413', '00000000-0000-7000-8000-000000000403', 1, 'initial product role', 'c0e59d0d67c579c2f4c33738d68960216f4fc70e2c2529451a0cef3bf3cebf91'),
  ('00000000-0000-7000-8000-000000000414', '00000000-0000-7000-8000-000000000404', 1, 'initial product role', '195eebd8b0414de3811844b3c6aa6fb2d18c4fe640266b920a79bbd3c978e64f'),
  ('00000000-0000-7000-8000-000000000415', '00000000-0000-7000-8000-000000000405', 1, 'initial product role', 'f963f197307e55f2c8cf3274e57673aa649446697c8bf5c5f06c21074b3808fb'),
  ('00000000-0000-7000-8000-000000000416', '00000000-0000-7000-8000-000000000406', 1, 'initial product role', 'a76739917c87cffd42db2dd1620d4df64577ae8b254c9314e5a71152ed656d7e')
ON CONFLICT (id) DO NOTHING;

UPDATE crm.roles AS role
SET current_revision_id = revision.id,
    updated_at = clock_timestamp()
FROM crm.role_revisions AS revision
WHERE revision.role_id = role.id
  AND revision.revision = 1
  AND role.current_revision_id IS NULL;

INSERT INTO crm.role_grants (id, role_revision_id, permission_code, scope)
SELECT
  ('00000000-0000-7000-8000-' || lpad((500 + row_number() OVER ())::text, 12, '0'))::uuid,
  '00000000-0000-7000-8000-000000000411'::uuid,
  permission.code,
  '{"records":"all"}'::jsonb
FROM crm.permission_catalog AS permission
ON CONFLICT (role_revision_id, permission_code) DO NOTHING;

INSERT INTO crm.role_grants (id, role_revision_id, permission_code, scope) VALUES
  ('00000000-0000-7000-8000-000000000601', '00000000-0000-7000-8000-000000000412', 'employees.manage', '{"records":"all"}'),
  ('00000000-0000-7000-8000-000000000602', '00000000-0000-7000-8000-000000000412', 'employees.unlock', '{"records":"all"}'),
  ('00000000-0000-7000-8000-000000000603', '00000000-0000-7000-8000-000000000412', 'roles.assign', '{"records":"all"}'),
  ('00000000-0000-7000-8000-000000000604', '00000000-0000-7000-8000-000000000412', 'contacts.read', '{"records":"all"}'),
  ('00000000-0000-7000-8000-000000000605', '00000000-0000-7000-8000-000000000412', 'schedule.read', '{"records":"all"}'),
  ('00000000-0000-7000-8000-000000000606', '00000000-0000-7000-8000-000000000412', 'schedule.manage', '{"records":"all"}'),
  ('00000000-0000-7000-8000-000000000607', '00000000-0000-7000-8000-000000000412', 'payments.read', '{"records":"all"}'),
  ('00000000-0000-7000-8000-000000000608', '00000000-0000-7000-8000-000000000412', 'payments.manage', '{"records":"all"}'),
  ('00000000-0000-7000-8000-000000000609', '00000000-0000-7000-8000-000000000413', 'medical.read.assigned', '{"records":"assigned"}'),
  ('00000000-0000-7000-8000-000000000610', '00000000-0000-7000-8000-000000000413', 'medical.write.assigned', '{"records":"assigned"}'),
  ('00000000-0000-7000-8000-000000000611', '00000000-0000-7000-8000-000000000414', 'medical.read.assigned', '{"records":"assigned"}'),
  ('00000000-0000-7000-8000-000000000612', '00000000-0000-7000-8000-000000000414', 'medical.write.assigned', '{"records":"assigned"}'),
  ('00000000-0000-7000-8000-000000000613', '00000000-0000-7000-8000-000000000415', 'medical.read.assigned', '{"records":"assigned"}'),
  ('00000000-0000-7000-8000-000000000614', '00000000-0000-7000-8000-000000000415', 'medical.write.assigned', '{"records":"assigned"}'),
  ('00000000-0000-7000-8000-000000000615', '00000000-0000-7000-8000-000000000416', 'medical.read.assigned', '{"records":"assigned"}'),
  ('00000000-0000-7000-8000-000000000616', '00000000-0000-7000-8000-000000000416', 'medical.write.assigned', '{"records":"assigned"}')
ON CONFLICT (role_revision_id, permission_code) DO NOTHING;
