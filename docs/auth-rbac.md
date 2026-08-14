# Auth and RBAC operations

Task 004 uses Supabase Auth only as the credential provider. CRM PostgreSQL rows
remain the source of truth for employee state, employment epoch, roles,
permissions, overrides, lockouts and CRM sessions.

Employees enter a separately assigned CRM username. Supabase receives only the
recovery email as its credential identifier; the email is never treated as the
visible CRM login. Recovery links are valid for 30 minutes, and temporary
passwords are single-use and expire after 72 hours.

## Deployment requirements

The Worker needs these values together; a partial Auth configuration is rejected:

- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`;
- `AUTH_PROVIDER_NAMESPACE`;
- `AUTH_TOKEN_ENCRYPTION_KEY` — a base64url-encoded 32-byte Worker secret;
- `AUTH_RECOVERY_CALLBACK_URL` — exact `/api/v1/auth/recovery/callback` API URL;
- `AUTH_RECOVERY_COMPLETE_URL` — exact frontend reset URL with an origin from `CORS_ORIGINS`.

Supabase must keep public signup, magic link, OTP, invite, OAuth, anonymous
identities, identity linking and generic Auth exposure disabled. The public API
contains only the BFF routes under `/api/v1/auth`; it never proxies `/auth/v1`.

## First leader

After migrations and Auth configuration, run the private deployment command once
against the runtime database role:

```sh
DATABASE_BOOTSTRAP_URL=... \
INITIAL_LEADER_FULL_NAME='...' \
INITIAL_LEADER_CONTACT_EMAIL='...' \
INITIAL_LEADER_LOGIN='...' \
INITIAL_LEADER_REASON='Initial clinic owner' \
bun run --cwd backend auth:bootstrap-initial-leader
```

The command emits a one-time temporary password. Store it only through an
approved secret hand-off; it is intentionally not saved by CRM. Afterward the
bootstrap operation refuses to run, and all employee changes require normal
server-side RBAC.

## Session and recovery model

The browser gets a short-lived opaque access token only in memory. The refresh
token and recovery grant use `__Host-` `HttpOnly; Secure; SameSite=Strict`
cookies. No authentication token belongs in browser storage or URLs.

CRM owns the 30-minute idle deadline and only `POST /session/continue` during
the warning interval extends it. Ordinary requests and polling do not extend a
session. Provider reconciliation is attempted at most every 30 minutes; a
provider outage does not immediately end a recently verified CRM session.

Password recovery uses a server-generated PKCE verifier and one-time state.
The BFF exchanges the returned code, puts only an opaque recovery grant in a
cookie, and updates the password server-side. Provider access and refresh tokens
never enter the browser.
