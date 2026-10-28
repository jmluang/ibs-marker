import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, clientAddress } from "../../server/app.ts";
import { createMemorySessionStore } from "../../server/sessionStore.ts";
import type { ServerConfig } from "../../server/app.ts";
import type { JsonRequest } from "../../server/curlTransport.ts";
// @ts-expect-error JavaScript CLI has no generated declarations.
import { loadRuntimeConfig } from "../../scripts/start-server.mjs";
const runtimeFixture = (root: string, env: Record<string, string> = {}) =>
  loadRuntimeConfig(root, { SESSION_ENCRYPTION_KEY: "ab".repeat(32), ...env });
const origin = "https://ibs.freecursorfuckoff.top";
const servers: ReturnType<typeof createApplication>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function fixture(
  overrides: Partial<ServerConfig> = {},
  handler?: JsonRequest,
  now?: () => number,
) {
  const calls: Parameters<JsonRequest>[0][] = [];
  const transport: JsonRequest = async (req) => {
    calls.push(req);
    if (handler) return handler(req);
    if (req.url.endsWith("/auth/v1/settings"))
      return {
        status: 200,
        body: { disable_signup: true, external: { anonymous_users: false } },
      };
    const user = {
      id: "f0000000-0000-4000-8000-000000000001",
      email: "u-616c696365@ibs-marker.invalid",
      email_confirmed_at: "2026-01-01",
      app_metadata: {
        ibs_marker_username: "alice",
        ibs_marker_registration: "invite",
      },
    };
    return { status: req.method === "POST" ? 201 : 200, body: user };
  };
  const server = createApplication(
    {
      publicOrigin: origin,
      sessionStore: createMemorySessionStore(),
      inviteCode: "test-invite",
      supabaseUrl: "https://fixture.supabase.co",
      supabasePublicKey: "public-test",
      supabaseSecretKey: "secret-test",
      supabaseAccessToken: "management-test",
      ...overrides,
    },
    transport,
    now,
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture");
  const url = `http://127.0.0.1:${address.port}`;
  const post = (
    data: unknown = {
      username: "alice",
      password: "pass12345",
      inviteCode: "test-invite",
    },
    headers: Record<string, string> = {},
  ) =>
    fetch(url + "/api/register", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(data),
    });
  return { server, url, post, calls };
}
function staticDir() {
  const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "invite-ready-"));
  dirs.push(d);
  mkdirSync(join(d, "assets"));
  writeFileSync(join(d, "index.html"), "<h1>fixture</h1>");
  writeFileSync(join(d, "assets/app.js"), "console.log(1)");
  writeFileSync(
    join(d, "asset-manifest.json"),
    JSON.stringify({
      buildId: "test",
      assets: ["/", "/index.html", "/assets/app.js"],
    }),
  );
  return d;
}
describe("invite registration server", () => {
  it.each([
    [
      { username: "alice", password: "123456", inviteCode: "test-invite" },
      "INVALID_PASSWORD",
    ],
    [
      {
        username: "alice",
        password: "界".repeat(342),
        inviteCode: "test-invite",
      },
      "INVALID_PASSWORD",
    ],
    [
      { username: " alice", password: "pass12345", inviteCode: "test-invite" },
      "INVALID_USERNAME",
    ],
    [
      {
        username: "界".repeat(11),
        password: "pass12345",
        inviteCode: "test-invite",
      },
      "INVALID_USERNAME",
    ],
    [
      { username: "alice", password: "pass12345", inviteCode: "" },
      "INVITE_REQUIRED",
    ],
    [
      { username: "alice", password: "pass12345", inviteCode: "x".repeat(513) },
      "INVITE_INVALID",
    ],
    [{ username: "alice", password: "pass12345" }, "INVALID_REQUEST"],
    [null, "INVALID_REQUEST"],
    [
      { username: "alice", password: 12345678, inviteCode: "test-invite" },
      "INVALID_REQUEST",
    ],
  ])(
    "returns safe local validation code without any provider request: %j",
    async (body, code) => {
      const f = await fixture();
      const r = await f.post(body);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ ok: false, code });
      expect(f.calls).toHaveLength(0);
    },
  );
  it.each([
    [422, { error_code: "email_exists", code: 422 }, 409, "USERNAME_TAKEN"],
    [422, { code: "user_already_exists" }, 409, "USERNAME_TAKEN"],
    [
      422,
      { error_code: 422, code: "user_already_exists" },
      409,
      "USERNAME_TAKEN",
    ],
    [400, { error_code: "user_already_registered" }, 409, "USERNAME_TAKEN"],
    [409, {}, 409, "USERNAME_TAKEN"],
    [422, { code: 422, error_code: "weak_password" }, 400, "INVALID_PASSWORD"],
    [422, { code: "password_too_short" }, 400, "INVALID_PASSWORD"],
    [
      422,
      { error_code: "weak_password", code: "email_exists" },
      400,
      "INVALID_PASSWORD",
    ],
    [
      422,
      { error_code: "unknown", code: "email_exists" },
      502,
      "REGISTRATION_FAILED",
    ],
    [429, {}, 429, "RATE_LIMITED"],
    [
      422,
      { message: "email_exists weak_password" },
      502,
      "REGISTRATION_FAILED",
    ],
    [500, { error_code: "unexpected" }, 502, "REGISTRATION_FAILED"],
  ])(
    "classifies provider HTTP %s machine codes only: %j",
    async (status, providerBody, expectedStatus, code) => {
      const f = await fixture(
        { allowProviderPublicSignup: true },
        async () => ({
          status,
          body: {
            message:
              "secret-test test-invite pass12345 u-616c696365@ibs-marker.invalid",
            ...providerBody,
          },
        }),
      );
      const r = await f.post();
      expect(r.status).toBe(expectedStatus);
      expect(await r.json()).toEqual({ ok: false, code });
      expect(f.calls.map((c) => c.method)).toEqual(["POST"]);
    },
  );
  it("sanitizes thrown provider details", async () => {
    const f = await fixture({ allowProviderPublicSignup: true }, async () => {
      throw Error(
        "secret-test test-invite pass12345 u-616c696365@ibs-marker.invalid",
      );
    });
    const r = await f.post();
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ ok: false, code: "REGISTRATION_FAILED" });
  });
  it.each([429, 500, 200])(
    "never succeeds on failed or malformed Admin readback: %s",
    async (status) => {
      const f = await fixture(
        { allowProviderPublicSignup: true },
        async (req) =>
          req.method === "POST"
            ? {
                status: 201,
                body: { id: "f0000000-0000-4000-8000-000000000001" },
              }
            : {
                status,
                body: { message: "secret-test test-invite pass12345" },
              },
      );
      const r = await f.post();
      expect(r.status).toBe(status === 429 ? 429 : 502);
      expect(await r.json()).toEqual({
        ok: false,
        code: status === 429 ? "RATE_LIMITED" : "REGISTRATION_FAILED",
      });
      expect(f.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    },
  );
  it("returns fixed Origin, body and rate codes while preserving unrelated routes", async () => {
    const f = await fixture({
      rateLimit: { perIp: 3, global: 3, maxIps: 1, windowMs: 60000 },
    });
    const denied = await f.post(undefined, { Origin: "https://evil.test" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ ok: false, code: "INVALID_REQUEST" });
    const malformed = await fetch(f.url + "/api/register", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
    const wrong = await f.post({
      username: "alice",
      password: "pass12345",
      inviteCode: "wrong",
    });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ ok: false, code: "INVITE_INVALID" });
    const limited = await f.post();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ ok: false, code: "RATE_LIMITED" });
    expect(await (await fetch(f.url + "/api/unknown")).json()).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    { inviteCode: "" },
    { supabaseSecretKey: "" },
    { supabasePublicKey: "" },
  ])(
    "returns unavailable for incomplete server config: %j",
    async (missing) => {
      const f = await fixture(missing);
      const r = await f.post();
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({
        ok: false,
        code: "REGISTRATION_UNAVAILABLE",
      });
      expect(f.calls).toHaveLength(0);
    },
  );
  it.each([undefined, "false", "true"])(
    "loads only the explicit server temporary mode: %s",
    async (value) => {
      const root = staticDir();
      // Client/public environment must not opt into a server-only mode.
      writeFileSync(
        join(root, ".env.local"),
        "ALLOW_PROVIDER_PUBLIC_SIGNUP=true\nVITE_ALLOW_PROVIDER_PUBLIC_SIGNUP=true\n",
      );
      const config = await runtimeFixture(
        root,
        value === undefined ? {} : { ALLOW_PROVIDER_PUBLIC_SIGNUP: value },
      );
      expect(config.allowProviderPublicSignup).toBe(value === "true");
    },
  );
  it.each(["", "TRUE", "False", "1", "yes", " true", "true ", "treu"])(
    "rejects mistyped temporary mode: %s",
    async (value) => {
      await expect(
        loadRuntimeConfig(staticDir(), { ALLOW_PROVIDER_PUBLIC_SIGNUP: value }),
      ).rejects.toThrow("SERVER_PUBLIC_SIGNUP_MODE_INVALID");
    },
  );
  it("loads temporary mode from private env with explicit environment override", async () => {
    const root = staticDir();
    writeFileSync(join(root, ".env"), "ALLOW_PROVIDER_PUBLIC_SIGNUP=true\n");
    expect((await runtimeFixture(root, {})).allowProviderPublicSignup).toBe(
      true,
    );
    expect(
      (await runtimeFixture(root, { ALLOW_PROVIDER_PUBLIC_SIGNUP: "false" }))
        .allowProviderPublicSignup,
    ).toBe(false);
  });
  it("temporarily serves app and invite registration without claiming provider signup is closed", async () => {
    const d = staticDir();
    writeFileSync(join(d, "sw.js"), "// worker");
    const f = await fixture(
      { distDir: d, allowProviderPublicSignup: true },
      async (req) => {
        if (req.url.endsWith("/settings"))
          return {
            status: 200,
            body: {
              disable_signup: false,
              external: { anonymous_users: false },
            },
          };
        return {
          status: req.method === "POST" ? 201 : 200,
          body: {
            id: "f0000000-0000-4000-8000-000000000001",
            email: "u-616c696365@ibs-marker.invalid",
            email_confirmed_at: "2026-01-01",
            app_metadata: {
              ibs_marker_username: "alice",
              ibs_marker_registration: "invite",
            },
          },
        };
      },
    );
    expect((await fetch(f.url + "/")).status).toBe(200);
    const ready = await fetch(f.url + "/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      ok: true,
      mode: "temporary-provider-public-signup",
    });
    expect((await fetch(f.url + "/sw.js?build=test")).status).toBe(200);
    for (const path of ["/.env", "/server/app.ts", "/sw.js?build=wrong"])
      expect((await fetch(f.url + path)).status).toBe(404);
    expect(
      (
        await f.post({
          username: "alice",
          password: "pass12345",
          inviteCode: "wrong",
        })
      ).status,
    ).toBe(403);
    expect(f.calls).toHaveLength(0);
    expect((await f.post()).status).toBe(201);
    expect(f.calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "https://fixture.supabase.co/auth/v1/admin/users"],
      [
        "GET",
        "https://fixture.supabase.co/auth/v1/admin/users/f0000000-0000-4000-8000-000000000001",
      ],
    ]);
    expect(f.calls[0].body).toMatchObject({
      email_confirm: true,
      app_metadata: { ibs_marker_registration: "invite" },
    });
  });
  it("temporary mode preserves Origin, body, rate limits and confirmed Admin readback", async () => {
    const f = await fixture(
      {
        allowProviderPublicSignup: true,
        rateLimit: { perIp: 4, global: 10, maxIps: 2, windowMs: 60000 },
      },
      async (req) => ({
        status: req.method === "POST" ? 201 : 200,
        body: {
          id: "f0000000-0000-4000-8000-000000000001",
          email: "u-616c696365@ibs-marker.invalid",
        },
      }),
    );
    expect(
      (await f.post(undefined, { Origin: "https://evil.test" })).status,
    ).toBe(403);
    expect(
      (
        await f.post({
          username: "alice",
          password: "pass12345",
          inviteCode: "test-invite",
          allowProviderPublicSignup: true,
        })
      ).status,
    ).toBe(400);
    expect(f.calls).toHaveLength(0);
    expect((await f.post()).status).toBe(502);
    expect(f.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    expect(
      (
        await f.post({
          username: "alice",
          password: "pass12345",
          inviteCode: "wrong",
        })
      ).status,
    ).toBe(403);
    expect((await f.post()).status).toBe(429);
    expect(f.calls).toHaveLength(2);
  });
  it.each([
    { supabaseSecretKey: "" },
    { supabasePublicKey: "" },
    { inviteCode: "" },
    { supabaseUrl: "" },
    { publicOrigin: "" },
  ])(
    "temporary mode still requires complete registration config, not for public shell: %o",
    async (missing) => {
      const f = await fixture({
        distDir: staticDir(),
        allowProviderPublicSignup: true,
        ...missing,
      });
      expect((await fetch(f.url + "/")).status).toBe(200);
      expect((await fetch(f.url + "/readyz")).status).toBe(503);
      expect((await f.post()).status).not.toBe(201);
      expect(f.calls).toHaveLength(0);
    },
  );
  it.each([undefined, false])(
    "retains strict default readiness and response shape: %s",
    async (allowProviderPublicSignup) => {
      const f = await fixture(
        { distDir: staticDir(), allowProviderPublicSignup },
        async () => ({
          status: 200,
          body: { disable_signup: false, external: { anonymous_users: false } },
        }),
      );
      const ready = await fetch(f.url + "/readyz");
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({
        ok: false,
        code: "AUTH_UNAVAILABLE",
      });
      expect((await fetch(f.url + "/")).status).toBe(200);
      expect((await f.post()).status).toBe(503);
      expect(f.calls).toHaveLength(1);
    },
  );
  it("serves the exact active service worker GET/HEAD from the immutable snapshot", async () => {
    const d = staticDir();
    const worker = "self.addEventListener('fetch', () => {});";
    writeFileSync(join(d, "sw.js"), worker);
    const f = await fixture({ distDir: d });
    // A later disk change must not authorize another build or change the snapshot.
    writeFileSync(
      join(d, "asset-manifest.json"),
      JSON.stringify({
        buildId: "later",
        assets: ["/index.html"],
      }),
    );
    writeFileSync(join(d, "sw.js"), "changed");
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(f.url + "/sw.js?build=test", { method });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/javascript; charset=utf-8",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-length")).toBe(
        String(Buffer.byteLength(worker)),
      );
      expect(await response.text()).toBe(method === "GET" ? worker : "");
    }
    expect((await fetch(f.url + "/sw.js")).status).toBe(200);
    expect((await fetch(f.url + "/sw.js?build=later")).status).toBe(404);
    expect(
      (await fetch(f.url + "/sw.js?build=test", { method: "POST" })).status,
    ).toBe(404);
  });
  it("does not normalize service worker queries or bypass the static allowlist", async () => {
    const d = staticDir();
    writeFileSync(join(d, "sw.js"), "// worker");
    writeFileSync(join(d, ".env"), "fixture-only-secret");
    const f = await fixture({ distDir: d });
    for (const path of [
      "/sw.js?build=wrong",
      "/sw.js?build=",
      "/sw.js?build",
      "/sw.js?build=test&build=test",
      "/sw.js?build=test&x=1",
      "/sw.js?x=1&build=test",
      "/sw.js?build=test&",
      "/sw.js?",
      "/sw.js?build=%74est",
      "/sw.js?%62uild=test",
      "/sw.js?build=TEST",
      "/%73w.js?build=test",
      "/sw.js/?build=test",
      "/assets/../sw.js?build=test",
      "/%2e%2e/sw.js?build=test",
      "/sw.js?build=test#fragment",
      "/.env?build=test",
      "/%2eenv?build=test",
      "/../.env?build=test",
      "/server/app.ts?build=test",
      "/assets/?build=test",
      "/assets/app.js?build=test",
      "/api/register?x=1",
      "/api/register?build=test",
    ]) {
      // Raw Node request preserves encoded, directory and traversal targets.
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(f.url, { path }, (response) => {
          response.resume();
          resolve(response.statusCode!);
        });
        req.on("error", reject);
        req.end();
      });
      expect(status, path).toBe(404);
    }
    expect(f.calls).toHaveLength(0);
  });
  it.each(["missing", "open", "unknown", "network"])(
    "serves the immutable active service worker independently of private readiness: %s",
    async (mode) => {
      const d = staticDir();
      writeFileSync(join(d, "sw.js"), "// worker");
      const f = await fixture(
        {
          distDir: d,
          ...(mode === "missing" ? { supabaseSecretKey: "" } : {}),
        },
        async () => {
          if (mode === "network") throw Error("offline");
          return {
            status: 200,
            body:
              mode === "open"
                ? {
                    disable_signup: false,
                    external: { anonymous_users: false },
                  }
                : {},
          };
        },
      );
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(f.url + "/sw.js?build=test", { method });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      expect(f.calls).toHaveLength(0);
    },
  );
  it("registers without a management PAT using only public Auth settings", async () => {
    const f = await fixture({ supabaseAccessToken: undefined });
    expect((await f.post()).status).toBe(201);
    expect(f.calls[0]).toEqual({
      method: "GET",
      url: "https://fixture.supabase.co/auth/v1/settings",
      headers: { apikey: "public-test" },
    });
    expect(f.calls.every((c) => !c.url.includes("api.supabase.com"))).toBe(
      true,
    );
    expect(f.calls[1].headers?.apikey).toBe("secret-test");
  });
  it("coalesces concurrent static/readiness checks and caches success for 30 seconds", async () => {
    let clock = 1000;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen = new Promise<void>((r) => {
      started = r;
    });
    const f = await fixture(
      { distDir: staticDir(), supabaseAccessToken: undefined },
      async () => {
        started();
        await gate;
        return {
          status: 200,
          body: { disable_signup: true, external: { anonymous_users: false } },
        };
      },
      () => clock,
    );
    expect((await fetch(f.url + "/healthz")).status).toBe(200);
    expect(f.calls).toHaveLength(0);
    const paths = ["/", "/assets/app.js", "/readyz", "/index.html", "/healthz"];
    const pending = Promise.all(paths.map((p) => fetch(f.url + p)));
    await seen;
    // Keep the provider pending while the other HTTP requests reach the gate.
    await new Promise((r) => setTimeout(r, 25));
    const pendingCalls = f.calls.length;
    release();
    expect(pendingCalls).toBe(1);
    expect((await pending).map((r) => r.status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    expect(f.calls).toHaveLength(1);
    clock += 29999;
    expect((await fetch(f.url + "/readyz")).status).toBe(200);
    expect(f.calls).toHaveLength(1);
    clock += 1;
    expect((await fetch(f.url + "/readyz")).status).toBe(200);
    expect(f.calls).toHaveLength(2);
  });
  it.each(["unknown", "network", "status", "open"])(
    "never reuses expired success after %s; retries failure after 2 seconds",
    async (mode) => {
      let clock = 1000;
      let healthy = true;
      const f = await fixture(
        { distDir: staticDir() },
        async () => {
          if (!healthy) {
            if (mode === "network") throw Error("offline");
            if (mode === "status") return { status: 503, body: {} };
            return {
              status: 200,
              body:
                mode === "open"
                  ? {
                      disable_signup: false,
                      external: { anonymous_users: false },
                    }
                  : {},
            };
          }
          return {
            status: 200,
            body: {
              disable_signup: true,
              external: { anonymous_users: false },
            },
          };
        },
        () => clock,
      );
      expect((await fetch(f.url + "/readyz")).status).toBe(200);
      healthy = false;
      clock += 30000;
      expect((await fetch(f.url + "/readyz")).status).toBe(503);
      expect((await fetch(f.url + "/assets/app.js")).status).toBe(200);
      expect((await f.post()).status).toBe(503);
      expect(f.calls).toHaveLength(2);
      healthy = true;
      clock += 1999;
      expect((await fetch(f.url + "/readyz")).status).toBe(503);
      expect(f.calls).toHaveLength(2);
      clock += 1;
      expect((await fetch(f.url + "/readyz")).status).toBe(200);
      expect(f.calls).toHaveLength(3);
    },
  );

  it.each(["", "wrong"])(
    "rejects invalid invite without ANY provider call %s",
    async (code) => {
      const f = await fixture();
      const r = await f.post({
        username: "alice",
        password: "pass12345",
        inviteCode: code,
      });
      expect(r.status).toBe(code ? 403 : 400);
      expect(await r.json()).toEqual({
        ok: false,
        code: code ? "INVITE_INVALID" : "INVITE_REQUIRED",
      });
      expect(f.calls).toHaveLength(0);
    },
  );
  it("creates confirmed mapped account then reads back before success", async () => {
    const f = await fixture();
    const r = await f.post();
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ ok: true });
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    expect(f.calls[1].body).toEqual({
      email: "u-616c696365@ibs-marker.invalid",
      password: "pass12345",
      email_confirm: true,
      app_metadata: {
        ibs_marker_username: "alice",
        ibs_marker_registration: "invite",
      },
    });
  });
  it("never resets duplicate users and sanitizes provider errors", async () => {
    const f = await fixture({}, async (req) =>
      req.url.endsWith("/auth/v1/settings")
        ? {
            status: 200,
            body: {
              disable_signup: true,
              external: { anonymous_users: false },
            },
          }
        : {
            status: 422,
            body: {
              error_code: "email_exists",
              message: "provider secret-test",
            },
          },
    );
    const r = await f.post();
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, code: "USERNAME_TAKEN" });
    expect(f.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });
  it.each([
    undefined,
    "null",
    "https://evil.test",
    origin + "/",
    "https://ibs.freecursorfuckoff.top.evil",
  ])("rejects Origin %s", async (bad) => {
    const f = await fixture();
    const r = await fetch(f.url + "/api/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bad ? { Origin: bad } : {}),
      },
      body: "{}",
    });
    expect(r.status).toBe(403);
    expect(f.calls).toHaveLength(0);
  });
  it("rejects non JSON, extra fields, malformed JSON, huge bodies", async () => {
    const f = await fixture();
    expect((await f.post({}, { "Content-Type": "text/plain" })).status).toBe(
      415,
    );
    expect(
      (
        await f.post({
          username: "alice",
          password: "pass12345",
          inviteCode: "test-invite",
          email: "bad",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.post({
          username: "alice",
          password: "x".repeat(20000),
          inviteCode: "test-invite",
        })
      ).status,
    ).toBe(413);
    const r = await fetch(f.url + "/api/register", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{",
    });
    expect(r.status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    { supabaseSecretKey: "" },
    { supabasePublicKey: "" },
    { inviteCode: "" },
  ])("is preparing for missing config %o", async (config) => {
    const f = await fixture(config);
    expect((await fetch(f.url + "/healthz")).status).toBe(200);
    expect((await fetch(f.url + "/readyz")).status).toBe(503);
    expect((await f.post()).status).not.toBe(201);
    expect((await fetch(f.url + "/")).status).toBe(503);
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    {},
    { disable_signup: true },
    { disable_signup: true, external: {} },
    { disable_signup: true, external: { anonymous_users: "false" } },
    { disable_signup: "true", external: { anonymous_users: false } },
    { disable_signup: false, external: { anonymous_users: false } },
    { disable_signup: true, external: { anonymous_users: true } },
  ])("fails closed on provider gate %o", async (body) => {
    const f = await fixture({}, async () => ({ status: 200, body }));
    expect((await f.post()).status).toBe(503);
    expect(f.calls).toHaveLength(1);
  });
  it("does not succeed on unconfirmed or mismatched read-back", async () => {
    const f = await fixture({}, async (req) =>
      req.url.endsWith("/auth/v1/settings")
        ? {
            status: 200,
            body: {
              disable_signup: true,
              external: { anonymous_users: false },
            },
          }
        : {
            status: 200,
            body: {
              id: "f0000000-0000-4000-8000-000000000001",
              email: "u-616c696365@ibs-marker.invalid",
            },
          },
    );
    expect((await f.post()).status).toBe(502);
  });
  it("limits IP and global budgets and never trusts spoofed XFF", async () => {
    const f = await fixture({
      rateLimit: { perIp: 1, global: 2, maxIps: 2, windowMs: 60000 },
    });
    expect(
      (
        await f.post(
          { username: "alice", password: "pass12345", inviteCode: "wrong" },
          { "X-Forwarded-For": "1.2.3.4", "CF-Connecting-IP": "1.2.3.4" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.post(undefined, {
          "X-Forwarded-For": "8.8.8.8",
          "CF-Connecting-IP": "8.8.8.8",
        })
      ).status,
    ).toBe(429);
  });
  it("trusts only an exact socket proxy and a single legal CF IP", () => {
    expect(
      clientAddress("127.0.0.1", { "cf-connecting-ip": "8.8.8.8" }, [
        "172.17.0.3",
      ]),
    ).toBe("127.0.0.1");
    expect(
      clientAddress("::ffff:172.17.0.3", { "cf-connecting-ip": "8.8.8.8" }, [
        "172.17.0.3",
      ]),
    ).toBe("8.8.8.8");
    expect(
      clientAddress("172.17.0.3", { "cf-connecting-ip": "8.8.8.8,1.1.1.1" }, [
        "172.17.0.3",
      ]),
    ).toBe("172.17.0.3");
  });
  it("times out slowly streamed bodies", async () => {
    const f = await fixture({ bodyTimeoutMs: 35 });
    const status = await new Promise<number>((resolve, reject) => {
      const r = httpRequest(
        f.url + "/api/register",
        {
          method: "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            "Content-Length": "200",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      r.on("error", reject);
      r.write("{");
    });
    expect(status).toBe(408);
  });
  it("serves only validated static allowlist, blocks secrets/traversal", async () => {
    const d = mkdtempSync(
      join(process.env.TMPDIR || tmpdir(), "invite-static-"),
    );
    dirs.push(d);
    mkdirSync(join(d, "assets"));
    writeFileSync(join(d, "index.html"), "<h1>fixture</h1>");
    writeFileSync(join(d, "assets/app.js"), "console.log(1)");
    writeFileSync(
      join(d, "asset-manifest.json"),
      JSON.stringify({
        buildId: "test",
        assets: ["/", "/index.html", "/assets/app.js"],
      }),
    );
    writeFileSync(join(d, ".env"), "SECRET");
    const f = await fixture({ distDir: d });
    expect((await fetch(f.url + "/")).status).toBe(200);
    for (const p of [
      "/.env",
      "/server/app.ts",
      "/scripts/start-server.mjs",
      "/%2e%2e/.env",
      "/assets/",
      "/unknown",
    ])
      expect((await fetch(f.url + p)).status).toBe(404);
    expect((await fetch(f.url + "/assets/app.js")).status).toBe(200);
  });
});
