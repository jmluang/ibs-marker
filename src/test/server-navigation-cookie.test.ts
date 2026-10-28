import { afterEach, expect, it } from "vitest";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createApplication } from "../../server/app.ts";
import { createMemorySessionStore } from "../../server/sessionStore.ts";
import type { JsonRequest } from "../../server/curlTransport.ts";
const origin = "https://app.fixture.invalid";
const uid = "f0000000-0000-4000-8000-000000000001";
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
  options: { noDist?: boolean; handler?: JsonRequest } = {},
) {
  let clock = 1000;
  const store = createMemorySessionStore({ now: () => clock, ttlMs: 100_999 });
  const d = mkdtempSync(join(process.env.TMPDIR!, "navigation-cookie-"));
  dirs.push(d);
  mkdirSync(join(d, "assets"));
  writeFileSync(join(d, "index.html"), "<!doctype html><h1>Public shell</h1>");
  writeFileSync(join(d, "assets/app.js"), "// public asset");
  writeFileSync(join(d, "sw.js"), "// immutable worker");
  writeFileSync(
    join(d, "asset-manifest.json"),
    JSON.stringify({
      buildId: "active",
      assets: ["/", "/index.html", "/assets/app.js"],
    }),
  );
  const calls: Parameters<JsonRequest>[0][] = [];
  const s = createApplication(
    {
      publicOrigin: origin,
      distDir: options.noDist ? undefined : d,
      inviteCode: "fixture-invite",
      supabaseUrl: "https://provider.fixture.invalid",
      supabasePublicKey: "fixture-public",
      supabaseSecretKey: "fixture-secret",
      sessionStore: store,
      rateLimit: { perIp: 1000, global: 1000, maxIps: 10, windowMs: 60000 },
    },
    async (r) => {
      calls.push(r);
      return options.handler ? options.handler(r) : { status: 503, body: {} };
    },
    () => clock,
  );
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const a = s.address();
  if (!a || typeof a === "string") throw Error();
  const base = `http://127.0.0.1:${a.port}`;
  const raw = (
    path: string,
    method = "GET",
    headers: Record<string, string> = {},
  ) =>
    new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      text: string;
    }>((resolve, reject) => {
      const r = request(base, { path, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            text: Buffer.concat(chunks).toString(),
          }),
        );
      });
      r.on("error", reject);
      r.end();
    });
  const api = (
    path: string,
    cookie = "",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    raw,
    api,
    calls,
    store,
    clock: (n: number) => {
      clock = n;
    },
  };
}
it("cross-site GET/HEAD shell query aliases and known assets need no provider readiness", async () => {
  const f = await fixture();
  for (const path of [
    "/",
    "/?x1",
    "/index.html?x1",
    "/?a=?/../.env",
    "/assets/app.js",
    "/sw.js?build=active",
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const r = await f.raw(path, method, {
        Origin: "https://external.invalid",
        "Sec-Fetch-Site": "cross-site",
        Accept: "text/html",
      });
      expect(r.status, path).toBe(200);
      expect(r.headers["set-cookie"]).toBeUndefined();
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
      expect(r.headers["content-type"]).toContain(
        path.startsWith("/assets/") || path.startsWith("/sw.js")
          ? "text/javascript"
          : "text/html",
      );
      if (method === "HEAD") expect(r.text).toBe("");
      if (!path.startsWith("/assets/"))
        expect(r.headers["cache-control"]).toBe("no-store");
    }
  }
  expect(f.calls).toHaveLength(0);
  expect((await f.api("/readyz")).status).toBe(503);
  const register = await f.api(
    "/api/register",
    "",
    {
      username: "alice",
      password: "fixture-password",
      inviteCode: "fixture-invite",
    },
    { Accept: "text/html" },
  );
  expect(register.status).toBe(503);
  expect(await register.json()).toEqual({
    ok: false,
    code: "REGISTRATION_UNAVAILABLE",
  });
  expect(f.calls).toHaveLength(1);
});
it("raw unknown/private/encoded routes and nonexact worker queries never alias public shell", async () => {
  const f = await fixture();
  for (const path of [
    "/settings",
    "/.env",
    "/.private/sessions",
    "/server/app.ts",
    "/%69ndex.html?x1",
    "/assets/../index.html?x1",
    "//index.html?x1",
    "/index.html/?x1",
    "/assets/app.js?x1",
    "/sw.js?build=wrong",
    "/sw.js?build=active&x=1",
    "/sw.js?build=%61ctive",
    "/sw.js?build=active&",
  ]) {
    const r = await f.raw(path);
    expect(r.status, path).toBe(404);
  }
  expect((await f.raw("/?x1", "POST")).status).toBe(404);
  expect(f.calls).toHaveLength(0);
});
it("API cross-site rejection, JSON/body and revision gates survive HTML Accept", async () => {
  const f = await fixture();
  for (const path of [
    "/api/auth/session",
    "/api/auth/bootstrap",
    "/api/register",
    "/api/sync/pull?cursor=0&limit=100",
    "/api/unknown",
  ]) {
    const r = await f.api(
      path,
      "",
      path.includes("bootstrap") || path === "/api/register" ? {} : undefined,
      { "Sec-Fetch-Site": "cross-site", Accept: "text/html" },
    );
    expect(r.status, path).toBe(403);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(await r.json()).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(r.headers.get("set-cookie")).toBeNull();
  }
  const bad = await f.api(
    "/api/auth/bootstrap",
    "",
    {},
    { "Content-Type": "text/plain", Accept: "text/html" },
  );
  expect(bad.status).toBe(415);
  expect(await bad.json()).toEqual({ ok: false, code: "INVALID_REQUEST" });
  expect(f.calls).toHaveLength(0);
});
it("missing shell returns safe HTML 503 for document GET/HEAD, not internal JSON", async () => {
  const f = await fixture({ noDist: true });
  for (const path of ["/", "/?x1", "/index.html?x1"]) {
    for (const method of ["GET", "HEAD"]) {
      const r = await f.raw(path, method, {
        Accept: "text/html",
        "Sec-Fetch-Site": "cross-site",
      });
      expect(r.status).toBe(503);
      expect(r.headers["content-type"]).toContain("text/html");
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.text).not.toMatch(
        /AUTH_UNAVAILABLE|REGISTRATION|supabase|SESSION_/,
      );
      if (method === "HEAD") expect(r.text).toBe("");
      else expect(r.text).toContain("<!doctype html>");
    }
  }
  const api = await f.api("/api/auth/session", "", undefined, {
    Accept: "text/html",
  });
  expect(api.status).toBe(428);
  expect(await api.json()).toEqual({
    ok: false,
    code: "SESSION_CONTEXT_REQUIRED",
  });
});
it("bootstrap adds floored remaining Max-Age, upgrades identical old SID without changing identity/revision/expiry", async () => {
  const f = await fixture({
    handler: async () => ({
      status: 200,
      body: { id: uid, app_metadata: { ibs_marker_username: "alice" } },
    }),
  });
  const boot = await f.api("/api/auth/bootstrap", "", {});
  expect(boot.status).toBe(200);
  const initial = boot.headers.get("set-cookie")!;
  expect(initial).toContain("Max-Age=100");
  const cookie = initial.split(";")[0];
  const sid = cookie.split("=")[1];
  const c = f.store.get(sid)!;
  f.store.cas(sid, c.authRevision, (x) => {
    x.auth = {
      user: { id: uid, displayName: "alice" },
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      expiresAt: 1_000_000,
    };
  });
  const before = f.store.get(sid)!;
  f.clock(2501);
  const upgraded = await f.api("/api/auth/bootstrap", cookie, {});
  expect(upgraded.status).toBe(200);
  expect(upgraded.headers.get("set-cookie")).toBe(
    `${cookie}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=99`,
  );
  expect(upgraded.headers.get("set-cookie")).not.toMatch(/Domain=|Expires=/i);
  expect(await upgraded.json()).toEqual({
    ok: true,
    user: before.auth!.user,
    authRevision: before.authRevision,
  });
  expect(f.store.get(sid)).toMatchObject({
    authRevision: before.authRevision,
    expiresAt: before.expiresAt,
    auth: { user: before.auth!.user },
  });
  f.clock(before.expiresAt - 1);
  const last = await f.api("/api/auth/bootstrap", cookie, {});
  expect(last.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(f.store.get(sid)!.expiresAt).toBe(before.expiresAt);
  f.clock(before.expiresAt);
  for (const path of [
    "/api/auth/session",
    "/api/auth/prepare",
    "/api/auth/login",
    "/api/auth/logout",
  ]) {
    const r = await f.api(
      path,
      cookie,
      path.endsWith("session") ? undefined : {},
    );
    expect(r.status).toBe(428);
    expect(r.headers.get("set-cookie")).toBeNull();
  }
});
