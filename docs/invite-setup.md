# Controlled invite-auth setup

**Implementation/fixtures only; real cloud configuration has NOT been executed or verified.** The parent operator alone loads actual credentials and authorizes execution. No pre-provisioned `APP_USERNAME` account is created; `APP_USERNAME` / `APP_PASSWORD` are obsolete, preserved verbatim, and unused here. Registration belongs to the separately controlled `/api/register` endpoint.

## Operator entrypoint (Node 26, no new dependencies)

From the project root, after review and explicit authorization:

```sh
node scripts/configure-invite-auth.ts --help
node scripts/configure-invite-auth.ts --project-ref=<exact-project-ref> --apply --allow-negative-tests
```

`npm run configure:invite-auth -- ...` is equivalent when the parent-owned package script is present. `--help` and missing/invalid authorization exit without reading env or loading transport. There is no secret argv option and no automatic execution on import. An authorized command is a real mutation/probe, **not** a dry run.

Inputs (private edits, never paste into chat):
- `.env`: server-only `SUPABASE_ACCESS_TOKEN` scoped PAT. The tool obtains an **existing** server key and saves only `SUPABASE_SECRET_KEY`; database passwords are not management credentials.
- `.env.local`: `VITE_SUPABASE_URL` plus `VITE_SUPABASE_PUBLISHABLE_KEY` (or legacy `VITE_SUPABASE_ANON_KEY`). Private fields must never have a `VITE_` prefix.
- Both files must be current-user owned, regular/non-symlink, mode exactly `0600`, valid UTF-8, and Git-ignored. Missing/unsafe files fail closed, without auto-chmod or secret dumps.
- Literal env grammar: `NAME=value`, optional `export `, whole-line comments, optional matching outer quotes. No interpolation, command substitution, value trimming, escape expansion or inline-comment removal. Duplicate/malformed declarations fail instead of guessing.

### Scoped PAT permissions

Restrict the token to **this project only**. The current official endpoint references require `auth_config_read`, `auth_config_write`, `project_admin_write`, `api_gateway_keys_read`, and `api_gateway_keys_secret_read` (the last permission is needed to reveal the existing server key). In particular, Auth configuration write alone is not the documented PATCH permission set: `project_admin_write` is also listed. Never silently expand project scope or request key-write/rotation permissions. Missing/wrong credential types fail before any external request; provider read/permission failure stops before PATCH. A provider rejection of PATCH fails closed, never rolls back to open signup. The application runtime neither requires the PAT nor calls the Management API; the PAT is setup authority only.

Official references reviewed:
- https://supabase.com/docs/reference/api/v1-get-auth-service-config
- https://supabase.com/docs/reference/api/v1-update-auth-service-config
- https://supabase.com/docs/reference/api/v1-get-project-api-keys
- https://supabase.com/docs/guides/auth/debugging/error-codes

## Reviewable sequence

1. Validate explicit apply + negative-test permission, PAT type, exact project ref/URL and public-key type.
2. GET target Management Auth config, then GET `/v1/projects/{ref}/api-keys?reveal=true`. Prefer an existing `secret` / `sb_secret_` key; fallback only to existing legacy `service_role` JWT whose role and project ref match. Never create/delete/rotate keys or accept anon/publishable keys as server keys.
3. Read-only Admin probe: GET `/auth/v1/admin/users?page=1&per_page=1`; check status/shape only, never report user records.
4. PATCH `/config/auth` with **exactly** `{disable_signup:true,external_anonymous_users_enabled:false}`. No SMTP, confirmation, JWT, redirect or other Auth changes.
5. Exact GET Management readback for both booleans; exact public GET `/auth/v1/settings` for `disable_signup===true` and `external.anonymous_users===false`. Missing/string/opposite flags fail. PATCH response alone is not success.
6. Only after both readbacks: public-key POST `/auth/v1/signup` using synthetic `invite-setup-<random-128-bit-nonce>@example.com`, a fresh random password and nonce metadata; then anonymous signup with the same owned metadata. Accept only HTTP 400/422 and exact machine errors `signup_disabled` (email), or `anonymous_provider_disabled` / `signup_disabled` (anonymous). SMTP, invalid-email, text-only, 401/429/5xx or ambiguous responses never pass.
7. On unexpected signup success: stop immediately. Cleanup is permitted only for a syntactically valid returned ID whose nonce and exact synthetic email (or anonymous marker and no email) match **both response and Admin GET-by-ID**. Delete that exact ID only, then require GET 404 `user_not_found`. Unknown/unproven accounts are never deleted. Even successful cleanup causes failure; no continued probe, key save, or reopening signup.
8. Save the verified server key only after every gate passes. Reports contain only fixed codes, status and booleans; no raw provider response, SMTP/key list, account data or password/token.

Shared `server/curlTransport.ts` is used only by the CLI, dynamically after validation. Its exact HTTPS origins are this project and `https://api.supabase.com`; default physical interface is `enp0s31f6`. No alternate HTTP implementation. The factory accepts `{request,secretStore,nonce?}` and never reads files or starts listeners.

## Local write/concurrency boundary

The file store retains an owner-checked original snapshot, takes exclusive `.env.invite-setup.lock`, compares inode/device/timestamps/size/constant-time bytes before writing and again immediately before atomic rename, fsyncs, and removes its temporary file/lock. Temporary secret content is `0600`, Git-ignored `.env.invite-setup-*.tmp`; there are no retained backups. Existing declarations/obsolete fields remain unchanged except `SUPABASE_SECRET_KEY`. Observed concurrent edits cause `SETUP_ENV_CHANGED`, not overwrite. All simultaneous env writers **must honor the lock**: portable filesystem compare+rename cannot provide kernel-level CAS against an uncooperative writer in the final check-to-rename interval. The parent may instead inject its own serialized private `secretStore.save(key)` callback. After a crash, inspect metadata only and safely remove stale lock/temp before retry; never print them. Later failures never re-enable signup.

## Isolated verification

Owned tests: `src/test/invite-setup.test.ts`. Evidence: `/home/luang/ibs-marker-verification/invite-setup/` (RED log, final GREEN log and JSON). The evidence-only Vitest config sets `envDir:false` and does not import the project Vite config. The native Node 26 subprocess additionally denies real env reads/child-process access, imports the `.ts` module without transformation, and completes an injected full fixture flow. Filesystem tests create only synthetic temp repositories under the configured scratch directory. No actual cloud requests, registrations/deletions, real env edits or runtime/port changes are part of acceptance here.
