-- Task 004: recovery grants are private server state.
REVOKE ALL ON TABLE crm.auth_recovery_challenges FROM PUBLIC, crm_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE crm.auth_recovery_challenges TO crm_runtime;
