import { afterEach, expect, it } from "vitest";
import { createApplication } from "../../server/app.ts";
import { createMemorySessionStore } from "../../server/sessionStore.ts";
import type { JsonRequest } from "../../server/curlTransport.ts";
const origin = "https://app.fixture.invalid";
const servers: ReturnType<typeof createApplication>[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
const uid = "f0000000-0000-4000-8000-000000000001";
async function fixture(handler?: JsonRequest) {
  const calls: Parameters<JsonRequest>[0][] = [];
  const server = createApplication(
    {
      publicOrigin: origin,
      supabaseUrl: "https://fixture.supabase.co",
      supabasePublicKey: "public-fixture",
      supabaseSecretKey: "admin-never-data",
      sessionStore: createMemorySessionStore(),
      rateLimit: { perIp: 1000, global: 1000, maxIps: 100, windowMs: 60000 },
    },
    async (r) => {
      calls.push(r);
      if (handler) return handler(r);
      return {
        status: 200,
        body: r.url.includes("/token?")
          ? {
              access_token: "jwt-fixture",
              refresh_token: "refresh-fixture",
              expires_in: 3600,
              user: { id: uid },
            }
          : { id: uid, app_metadata: { ibs_marker_username: "alice" } },
      };
    },
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw Error();
  const url = `http://127.0.0.1:${a.port}`;
  let cookie = "";
  const req = async (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const boot = async () => {
    const r = await req("/api/auth/bootstrap", {});
    cookie = r.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return { r, b: await r.json() };
  };
  const login = async (revision: string) => {
    const p = await req("/api/auth/prepare", { authRevision: revision });
    const b = await p.json();
    const r = await req("/api/auth/login", {
      username: "alice",
      password: "fixture-pass",
      ...{ attemptId: b.attemptId, authRevision: b.authRevision },
    });
    return { r, b: await r.json() };
  };
  return { req, boot, login, calls };
}
it("bootstrap alone creates secure context; session never sets a cookie or leaks tokens", async () => {
  const f = await fixture();
  const missing = await f.req("/api/auth/session");
  expect(missing.status).toBe(428);
  expect(missing.headers.get("set-cookie")).toBeNull();
  const { r, b } = await f.boot();
  expect(r.status).toBe(200);
  expect(r.headers.get("set-cookie")).toMatch(
    /^__Host-ibs_session=[a-f0-9]{64};.*HttpOnly.*Secure.*SameSite=Strict/,
  );
  expect(b).toMatchObject({
    ok: true,
    user: null,
    authRevision: expect.any(String),
  });
  expect((await f.boot()).r.headers.get("set-cookie")?.split(";")[0]).toBe(
    r.headers.get("set-cookie")?.split(";")[0],
  );
  const l = await f.login(b.authRevision);
  expect(l.r.status).toBe(200);
  expect(l.r.headers.get("set-cookie")).toBeNull();
  expect(l.b).toEqual({
    ok: true,
    user: { id: uid, displayName: "alice" },
    authRevision: expect.any(String),
  });
  expect(JSON.stringify(l.b)).not.toMatch(
    /jwt-fixture|refresh-fixture|supabase|admin-never-data/,
  );
  const s = await f.req("/api/auth/session");
  expect(s.status).toBe(200);
  expect(s.headers.get("cache-control")).toBe("no-store");
  expect(s.headers.get("set-cookie")).toBeNull();
  expect(f.calls[0].headers).toEqual({ apikey: "public-fixture" });
});
it("CAS rejects stale prepare/logout and old queued sync before upstream", async () => {
  const f = await fixture();
  const { b } = await f.boot();
  const l = await f.login(b.authRevision);
  const n = f.calls.length;
  for (const path of ["/api/auth/prepare", "/api/auth/logout"]) {
    const r = await f.req(path, { authRevision: b.authRevision });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, code: "SESSION_CHANGED" });
  }
  expect(
    (
      await f.req("/api/sync/pull?cursor=0&limit=100", undefined, {
        "X-Auth-Revision": b.authRevision,
      })
    ).status,
  ).toBe(409);
  expect(f.calls.length).toBe(n);
  expect((await f.req("/api/auth/session")).status).toBe(200);
  expect(l.b.user.id).toBe(uid);
});
