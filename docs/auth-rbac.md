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
- `API_PUBLIC_ORIGIN` — exact public origin of the Auth API;
- `AUTH_RECOVERY_CALLBACK_URL` — exact `/api/v1/auth/recovery/callback` API URL;
- `AUTH_RECOVERY_COMPLETE_URL` — exact frontend reset URL with an origin from `CORS_ORIGINS`.

The Worker config also declares separate identity and source rate-limit bindings.
Their `namespace_id` values must remain unique within the Cloudflare account.
Sign-in is limited per canonical CRM login and per Cloudflare connection source;
recovery has the same edge protection plus a database-backed one-request-per-minute
cooldown for each employee.

Refresh tokens rotate on every use. A spent token normally revokes its whole
session family when replayed; for ten seconds the encrypted successor mapping
returns the exact already-issued token pair to a parallel tab or a client whose
first response was lost. It never revokes the shared Supabase session for this
benign duplicate. Provider bans, session revocations, provisioning and restore
effects that fail transiently are encrypted/persisted in `security_outbox` and
retried on requests and by the five-minute Worker cron reconciler. Recovery delivery runs under the Worker execution
context, so the public endpoint always keeps the same enumeration-safe `202`
response.

Worker unit tests use `backend/tests/wrangler.test.jsonc`, located away from local
`.dev.vars` files, and inject only a test-only no-op secret. Real developer or
deployment credentials are never loaded into the test harness.

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

If Supabase is unavailable during the first run, repeat the same command with
the same leader data. The encrypted pending bootstrap is resumed only by this
private CLI; the background reconciler never activates the first leader without
an opportunity to return the original one-time password.

## Session and recovery model

The browser gets a short-lived opaque access token only in memory. The refresh
token and recovery grant use `__Host-` `HttpOnly; Secure; SameSite=Strict`
cookies. No authentication token belongs in browser storage or URLs.

CRM owns the 30-minute idle deadline and only `POST /session/continue` during
the warning interval extends it. Ordinary requests and polling do not extend a
session. Provider reconciliation is attempted at most every 30 minutes; a
provider outage does not immediately end a recently verified CRM session.

Logout clears the HttpOnly refresh cookie only after the database confirms the
session revoke. A transient failure leaves the authenticated UI and cookie intact
so the user can retry instead of receiving a false success. Confirmed logout is
broadcast to every open tab, which immediately clears in-memory tokens and private
TanStack Query caches.

Password recovery uses a server-generated PKCE verifier and one-time state.
The BFF exchanges the returned code, puts only an opaque recovery grant in a
cookie, and updates the password server-side. Provider access and refresh tokens
never enter the browser.

Every password mutation (self-service change, recovery reset and administrative
temporary-password issue) owns a unique database operation ID while the
credential is `changing`. Only that owner may finalize the provider result, so
cross-flow races cannot report two successful passwords. Self-service claims
must still match the session and credential epochs observed before provider
verification; recovery grants are bound to the credential epoch at issue and
are expired after any successful password mutation.
