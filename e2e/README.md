# Browser-only same-origin BFF fixtures

These tests exercise the real React UI against **synthetic same-origin BFF routes**.
They are not Supabase/provider acceptance or production Node-server acceptance.
Only `e2e/**` belongs to this fixture migration; application/server fixes are separate.

## Safety and contract

- `invite.vite.config.ts` is independent, uses `envDir: false`, and only exposes
  `VITE_APP_MODE`. No real `.env`, public provider URL/key, provider SDK session,
  token, cloud account, or external endpoint is needed.
- `bff.fixture.ts` installs a browser-context HTTP/WebSocket firewall before any
  navigation. All foreign origins, provider-style `/auth/` and `/rest/` routes,
  and browser Authorization/apikey headers are blocked and fail the test.
  It also covers newly opened tabs. Development fixtures block Service Workers
  so SW-owned fetches cannot bypass the routing firewall.
- Only `/api/auth/bootstrap {}` can establish a stable HttpOnly context cookie.
  Session probes without that cookie return 428 with no cookie. Prepare/login/
  logout use explicit revision CAS; sync uses captured `X-Auth-Revision`.
- Session metadata contains only user/revision/lock state, never credentials.
  Registration success is exactly HTTP 201; registration and auto-login remain
  separate outcomes. All health data, credentials, and invite values are synthetic.
- Workers are serial. Every fixture server owns loopback **15007**, refuses reuse,
  and is stopped by Playwright. Do not run these configs concurrently or repoint
  them at someone else's running service. No dependency installation is required.

## Run

From the repository root, use the installed binaries:

```sh
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/home/luang/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome
export IBS_EVIDENCE_DIR=/home/luang/ibs-marker-verification/backend-only-cloud/browser-fixtures/new-run
./node_modules/.bin/playwright test --config e2e/invite.fixture.config.ts
```

`invite.fixture.config.ts` now runs 33 tests: 2 unavailable-backend gates, 10 invite/
registration cases, 4 offline/data-isolation cases, 6 session/race cases, and 11
refresh/recovery cases. `offline.fixture.config.ts` selects the four API-offline/
data cases. `local.fixture.config.ts` explicitly sets `VITE_APP_MODE=local` and
preserves the 15 tracker/date/layout tests:

```sh
./node_modules/.bin/playwright test --config e2e/local.fixture.config.ts
```

The root `bootstrap.spec.ts` path is now backend-outage gating, not incomplete
public provider configuration. No provider request is mocked or fulfilled.

## Coverage boundaries

- Bootstrap: two tabs share one cookie; gates hold both the bootstrap response
  and its confirmation response. The second tab must remain queued on
  `ibs-marker-bff-bootstrap` without probing or bootstrapping through the lock.
  Missing Web Locks refuse a new handshake.
- Auth races: B commits before old A is released, including an old *successful*
  login response body. Old login/cleanup/logout cannot erase B; refreshing each
  tab restores B or deliberately locks stale visible UI before explicit restore.
- Data: logout immediately hides A; B never sees/pushes A's partition or queue;
  relogin A preserves its pending operation; a late A pull cannot populate B;
  safe 23505 business errors retain the queue without raw provider text.
- Offline fixture: the shell stays available from isolated Vite while **all BFF
  API transport is aborted**. A real BFF login initializes noncredential metadata,
  then a refresh restores the same user's local records/outbox. Offline logout
  locks subsequent refresh without deleting the partition.

**Production cold-offline SW behavior remains separate.** These tests do not run
Vite preview, warm caches, seed fake provider tokens, or claim a cold-offline
production pass. Parent acceptance must use the final built artifact served by
the actual production Node server: versioned SW URL, cold precache without an
extra online reload, API/auth cache exclusions, genuine offline navigation,
record/outbox preservation, and offline logout. Actual provider integration also
requires the parent's server-side provider fixture/live acceptance, not this
browser route fixture.

## Executed evidence

Evidence root: `/home/luang/ibs-marker-verification/backend-only-cloud/browser-fixtures/`.
Machine-readable `playwright.json` counts and embedded `bff-network` attachments
were parsed rather than inferred from console output:

- `final/`: **22/22 passed**, zero forbidden requests, zero page errors.
- `local/`: **13/13 passed**, zero forbidden requests, zero page errors.
- `strict-bootstrap/`: stricter full-handshake assertion repeated **3/3 passed**,
  zero forbidden requests, zero page errors.
- Standalone strict TypeScript check over `e2e/*.ts` passed using the installed
  compiler (`--ignoreConfig --noEmit --strict`, Node/Vite types, bundler modules).

Earlier RED and rerun evidence was preserved. During concurrent application
work, early runs caught the old pre-lock probe and one React `removeChild` page
error; a resource-constrained repeat also hit the old 5-second assertion budget.
The current full run is green, the strict handshake gate was rerun three times,
and browser page errors remain test failures rather than being filtered out.
Timeouts are bounded at 60 seconds per case / 15 seconds per assertion for this
shared host; retries are not enabled.

## Refresh/session repair verification

Current evidence: `/home/luang/ibs-marker-verification/refresh-session/sw-browser/`.

- `sw-red.log`: original worker failed 28 of the initial 41 navigation regressions.
- `sw-green.log`: final VM worker regressions pass, including queried known pages,
  JSON/non-HTML/HTTP/network failures, successful HTML passthrough, noninterception
  of API/unknown/private paths, exact asset query rules, and no error cache writes.
- `native/`: one native Chromium Service Worker test passes against the actual
  `public/sw.js` and a **synthetic Node HTTP shell**, including different-origin
  loopback link entry, query refresh, JSON 403/503/200 document responses, genuine
  browser offline navigation, API noninterception and unchanged shell cache keys.
  Run it separately (same owned port 15007):
  `playwright test --config e2e/sw.fixture.config.ts`.
- `bff-final/`: 33/33 pass, zero forbidden requests and zero page errors. Healthy
  probes still bootstrap and confirm under the same Web Lock; two tabs share one
  SID rather than requiring one bootstrap request. Legacy session-cookie upgrade
  sets remaining Max-Age without rotating SID/revision/user or extending context
  expiry. Recovery covers cached/no-cache 503, retry/online restoration, probe
  contradiction quarantine, explicit-lock persistence and safe/unsafe permissions.
- `local-final/`: 15/15 tracker/date/layout cases pass.
- Root and standalone strict e2e TypeScript checks pass.

Preserved early browser failures include shared-host storage/assertion/teardown
stalls and recovery-copy assertions written while the frontend writer was still
updating its lock policy. Final assertions check durable locks, visible identity
and safe errors without requiring the temporary connection copy for a positively
contradicted session. No production provider, real user data, production ports,
or browser-close/reopen acceptance is covered by these synthetic fixtures.

