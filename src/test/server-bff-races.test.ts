import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApplication } from "../../server/app.ts";
import type { ServerConfig } from "../../server/app.ts";
import {
  createMemorySessionStore,
  createFileSessionStore,
} from "../../server/sessionStore.ts";
import type { SessionStore } from "../../server/sessionStore.ts";
import type {
  JsonRequest,
  JsonRequestInput,
} from "../../server/curlTransport.ts";
import { usernameToInternalEmail } from "../domain/username.ts";
const origin = "https://app.fixture.invalid";
const ids = {
  alice: "f0000000-0000-4000-8000-000000000001",
  bob: "f0000000-0000-4000-8000-000000000002",
};
const servers: ReturnType<typeof createApplication>[] = [];
const stores: SessionStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function gate() {
  let release!: (v?: void) => void;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
}
function token(name: keyof typeof ids, rotated = false) {
  return {
    access_token: `jwt-${name}${rotated ? "-rotated" : ""}`,
    refresh_token: `refresh-${name}${rotated ? "-rotated" : ""}`,
    expires_in: 3600,
    user: { id: ids[name] },
  };
}
function user(name: keyof typeof ids) {
  return {
    id: ids[name],
    app_metadata: { ibs_marker_username: name },
    user_metadata: { ibs_marker_username: "UNTRUSTED" },
  };
}
function provider(r: JsonRequestInput) {
  if (r.url.endsWith("grant_type=password")) {
    const name =
      (r.body as { email: string }).email === usernameToInternalEmail("bob")
        ? "bob"
        : "alice";
    return { status: 200, body: token(name) };
  }
  if (r.url.endsWith("grant_type=refresh_token")) {
    const name = (r.body as { refresh_token: string }).refresh_token.includes(
      "bob",
    )
      ? "bob"
      : "alice";
    return { status: 200, body: token(name, true) };
  }
  if (r.url.endsWith("/auth/v1/user"))
    return {
      status: 200,
      body: user(r.headers?.Authorization?.includes("bob") ? "bob" : "alice"),
    };
  if (r.url.includes("tracker_changes")) return { status: 200, body: [] };
  return { status: 200, body: {} };
}
async function fixture(
  handler?: (
    r: JsonRequestInput,
  ) => Promise<Awaited<ReturnType<JsonRequest>> | undefined>,
  options: Partial<ServerConfig> = {},
  now: () => number = Date.now,
) {
  const store = options.sessionStore ?? createMemorySessionStore();
  stores.push(store);
  const calls: JsonRequestInput[] = [];
  const server = createApplication(
    {
      publicOrigin: origin,
      supabaseUrl: "https://provider.fixture.invalid",
      supabasePublicKey: "public-fixture",
      supabaseSecretKey: "ADMIN_FOR_REGISTRATION_ONLY",
      sessionStore: store,
      rateLimit: { perIp: 1000, global: 1000, maxIps: 100, windowMs: 60000 },
      ...options,
    },
    async (r) => {
      calls.push(r);
      return (await handler?.(r)) ?? provider(r);
    },
    now,
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw Error();
  const base = `http://127.0.0.1:${a.port}`;
  let cookie = "";
  const req = async (
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const boot = async () => {
    const r = await req("/api/auth/bootstrap", {});
    cookie = r.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    expect(r.status).toBe(200);
    return (await r.json()) as { authRevision: string };
  };
  const prepare = async (rev: string) => {
    const r = await req("/api/auth/prepare", { authRevision: rev });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBeNull();
    return (await r.json()) as { authRevision: string; attemptId: string };
  };
  const login = async (
    p: { authRevision: string; attemptId: string },
    name = "alice",
  ) =>
    req("/api/auth/login", {
      authRevision: p.authRevision,
      attemptId: p.attemptId,
      username: name,
      password: "fake-only-password",
    });
  const signin = async (rev: string, name = "alice") => {
    const p = await prepare(rev);
    const r = await login(p, name);
    expect(r.status).toBe(200);
    return (await r.json()) as {
      authRevision: string;
      user: { id: string; displayName: string };
    };
  };
  const pull = (rev: string) =>
    req("/api/sync/pull?cursor=0&limit=100", undefined, {
      "X-Auth-Revision": rev,
    });
  return {
    base,
    store,
    calls,
    req,
    boot,
    prepare,
    login,
    signin,
    pull,
    getCookie: () => cookie,
    setCookie: (v: string) => {
      cookie = v;
    },
    server,
  };
}
it.each(["grant", "user"])(
  "cancellation/new B fences late successful A at %s before durable token commit",
  async (phase) => {
    const started = gate(),
      late = gate();
    const f = await fixture(async (r) => {
      if (
        (phase === "grant" &&
          r.url.endsWith("grant_type=password") &&
          (r.body as { email: string }).email ===
            usernameToInternalEmail("alice")) ||
        (phase === "user" &&
          r.url.endsWith("/user") &&
          r.headers?.Authorization === "Bearer jwt-alice")
      ) {
        started.release();
        await late.wait;
        return provider(r);
      }
      return undefined;
    });
    const initial = await f.boot();
    const a = await f.prepare(initial.authRevision);
    const pending = f.login(a);
    await started.wait;
    const cancel = await f.req("/api/auth/logout", {
      authRevision: a.authRevision,
    });
    expect(cancel.status).toBe(200);
    expect(cancel.headers.get("set-cookie")).toBeNull();
    const b = await f.signin((await cancel.json()).authRevision, "bob");
    late.release();
    const rejected = await pending;
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      ok: false,
      code: "SESSION_CHANGED",
    });
    const state = f.store.get(f.getCookie().split("=")[1])!;
    expect(state.auth?.accessToken).toBe("jwt-bob");
    expect(state.authRevision).toBe(b.authRevision);
    expect((await (await f.req("/api/auth/session")).json()).user.id).toBe(
      ids.bob,
    );
  },
);
it("late logout revoke uses only captured A JWT with scope=local and cannot erase B", async () => {
  const started = gate(),
    late = gate();
  const f = await fixture(async (r) => {
    if (r.url.includes("/logout?")) {
      expect(r.url).toBe(
        "https://provider.fixture.invalid/auth/v1/logout?scope=local",
      );
      expect(r.headers).toEqual({
        apikey: "public-fixture",
        Authorization: "Bearer jwt-alice",
      });
      started.release();
      await late.wait;
      throw Error("provider PRIVATE error");
    }
    return undefined;
  });
  const a = await f.signin((await f.boot()).authRevision);
  const pending = f.req("/api/auth/logout", { authRevision: a.authRevision });
  await started.wait;
  const c = f.store.get(f.getCookie().split("=")[1])!;
  expect(c.auth).toBeNull();
  expect(c.authRevision).not.toBe(a.authRevision);
  const b = await f.signin(c.authRevision, "bob");
  late.release();
  const r = await pending;
  expect(r.status).toBe(200);
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(f.store.get(f.getCookie().split("=")[1])?.auth?.user.id).toBe(ids.bob);
  expect((await (await f.req("/api/auth/session")).json()).authRevision).toBe(
    b.authRevision,
  );
});
it.each(["http401", "network"])(
  "in-flight A sync %s after B login is SESSION_CHANGED and never refreshes/clears B",
  async (mode) => {
    const started = gate(),
      late = gate();
    const f = await fixture(async (r) => {
      if (r.url.includes("tracker_changes")) {
        expect(r.headers).toEqual({
          apikey: "public-fixture",
          Authorization: "Bearer jwt-alice",
        });
        started.release();
        await late.wait;
        if (mode === "network") throw Error("private provider");
        return {
          status: 401,
          body: { code: "PGRST301", message: "provider private" },
        };
      }
      return undefined;
    });
    const a = await f.signin((await f.boot()).authRevision);
    const pending = f.pull(a.authRevision);
    await started.wait;
    const b = await f.signin(a.authRevision, "bob");
    late.release();
    const r = await pending;
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, code: "SESSION_CHANGED" });
    expect(
      f.calls.filter((r) => r.url.endsWith("grant_type=refresh_token")),
    ).toHaveLength(0);
    expect(f.store.get(f.getCookie().split("=")[1])?.authRevision).toBe(
      b.authRevision,
    );
  },
);
it("late invalid A refresh cannot clear new B", async () => {
  let clock = 100000;
  const started = gate(),
    late = gate();
  const f = await fixture(
    async (r) => {
      if (r.url.endsWith("grant_type=refresh_token")) {
        started.release();
        await late.wait;
        return { status: 400, body: { error_code: "refresh_token_not_found" } };
      }
      return undefined;
    },
    {},
    () => clock,
  );
  const a = await f.signin((await f.boot()).authRevision);
  clock += 3600000;
  const pending = f.pull(a.authRevision);
  await started.wait;
  const b = await f.signin(a.authRevision, "bob");
  late.release();
  expect((await pending).status).toBe(409);
  expect(f.store.get(f.getCookie().split("=")[1])?.auth?.user.id).toBe(ids.bob);
  expect(f.store.get(f.getCookie().split("=")[1])?.authRevision).toBe(
    b.authRevision,
  );
});
it("singleflight refresh durably rotates before data use and survives a true store restart", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR!, "bff-refresh-"));
  dirs.push(dir);
  const opts = {
    path: join(dir, "sessions.enc"),
    encryptionKey: "bc".repeat(32),
  };
  let disk = createFileSessionStore(opts);
  let clock = 100000;
  const started = gate(),
    late = gate();
  const f = await fixture(
    async (r) => {
      if (r.url.endsWith("grant_type=refresh_token")) {
        started.release();
        await late.wait;
      }
      if (r.url.includes("tracker_changes")) {
        expect(r.headers?.Authorization).toBe("Bearer jwt-alice-rotated");
        expect(disk.get(f.getCookie().split("=")[1])?.auth?.refreshToken).toBe(
          "refresh-alice-rotated",
        );
      }
      return undefined;
    },
    { sessionStore: disk },
    () => clock,
  );
  const a = await f.signin((await f.boot()).authRevision);
  clock += 3600000;
  const requests = Array.from({ length: 5 }, () => f.pull(a.authRevision));
  await started.wait;
  await new Promise((r) => setTimeout(r, 25));
  late.release();
  expect(
    (await Promise.all(requests)).map((r) => {
      expect(r.headers.get("set-cookie")).toBeNull();
      return r.status;
    }),
  ).toEqual([200, 200, 200, 200, 200]);
  expect(
    f.calls.filter((r) => r.url.endsWith("grant_type=refresh_token")),
  ).toHaveLength(1);
  const sid = f.getCookie().split("=")[1];
  expect(disk.get(sid)?.authRevision).toBe(a.authRevision);
  const before = disk.get(sid);
  disk.close();
  disk = createFileSessionStore(opts);
  stores.push(disk);
  expect(disk.get(sid)).toEqual(before);
  expect(disk.get(sid)?.auth?.refreshToken).toBe("refresh-alice-rotated");
  const restarted = await fixture(
    undefined,
    { sessionStore: disk },
    () => clock,
  );
  restarted.setCookie(f.getCookie());
  const restored = await restarted.req("/api/auth/session");
  expect(restored.status).toBe(200);
  expect(restored.headers.get("set-cookie")).toBeNull();
  expect(await restored.json()).toEqual({
    ok: true,
    user: { id: ids.alice, displayName: "alice" },
    authRevision: a.authRevision,
  });
  expect((await restarted.pull(a.authRevision)).status).toBe(200);
  expect(
    restarted.calls.some((r) => r.url.endsWith("grant_type=refresh_token")),
  ).toBe(false);
  expect(
    restarted.calls.every(
      (r) => r.headers?.Authorization === "Bearer jwt-alice-rotated",
    ),
  ).toBe(true);
  expect(
    readFileSync(opts.path).includes(Buffer.from("refresh-alice-rotated")),
  ).toBe(false);
});
it.each([400, 401, 429, 503])(
  "transient/unknown refresh HTTP %s retains session; only definitive machine codes clear it",
  async (status) => {
    let clock = 100000;
    const f = await fixture(
      async (r) =>
        r.url.endsWith("grant_type=refresh_token")
          ? {
              status,
              body: {
                error_code: "unknown",
                message: "invalid refresh token PRIVATE",
              },
            }
          : undefined,
      {},
      () => clock,
    );
    const a = await f.signin((await f.boot()).authRevision);
    clock += 3600000;
    const r = await f.req("/api/auth/session");
    expect(r.status).toBe(status === 429 ? 429 : 503);
    expect(await r.json()).toEqual({
      ok: false,
      code: status === 429 ? "RATE_LIMITED" : "AUTH_UNAVAILABLE",
    });
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(f.store.get(f.getCookie().split("=")[1])?.auth?.user.id).toBe(
      ids.alice,
    );
    expect(f.store.get(f.getCookie().split("=")[1])?.authRevision).toBe(
      a.authRevision,
    );
  },
);
it("definitive refresh expiry clears only captured revision and returns safe 401 without cookie", async () => {
  let clock = 100000;
  const f = await fixture(
    async (r) =>
      r.url.endsWith("grant_type=refresh_token")
        ? { status: 400, body: { error_code: "refresh_token_not_found" } }
        : undefined,
    {},
    () => clock,
  );
  const a = await f.signin((await f.boot()).authRevision);
  clock += 3600000;
  const r = await f.req("/api/auth/session");
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ ok: false, code: "SESSION_EXPIRED" });
  expect(r.headers.get("set-cookie")).toBeNull();
  const c = f.store.get(f.getCookie().split("=")[1])!;
  expect(c.auth).toBeNull();
  expect(c.authRevision).not.toBe(a.authRevision);
});
it("session /user network errors are 503, not fake logout", async () => {
  let offline = false;
  const f = await fixture(async (r) => {
    if (offline && r.url.endsWith("/user"))
      throw Error("PRIVATE KEY URL TOKEN");
    return undefined;
  });
  const a = await f.signin((await f.boot()).authRevision);
  offline = true;
  const r = await f.req("/api/auth/session");
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ ok: false, code: "AUTH_UNAVAILABLE" });
  expect(f.store.get(f.getCookie().split("=")[1])?.authRevision).toBe(
    a.authRevision,
  );
  offline = false;
  expect((await f.req("/api/auth/session")).status).toBe(200);
});
it.each([
  [400, "invalid_credentials", 401, "INVALID_CREDENTIALS"],
  [400, "validation_failed", 503, "AUTH_UNAVAILABLE"],
  [500, "invalid_credentials", 503, "AUTH_UNAVAILABLE"],
  [429, "anything", 429, "RATE_LIMITED"],
])(
  "login conservatively classifies HTTP %s / %s",
  async (status, code, expected, safe) => {
    const f = await fixture(async (r) =>
      r.url.endsWith("grant_type=password")
        ? {
            status: status as number,
            body: { error_code: code, message: "PRIVATE PASSWORD TOKEN URL" },
          }
        : undefined,
    );
    const p = await f.prepare((await f.boot()).authRevision);
    const r = await f.login(p);
    expect(r.status).toBe(expected);
    expect(await r.json()).toEqual({ ok: false, code: safe });
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(f.store.get(f.getCookie().split("=")[1])?.auth).toBeNull();
  },
);
it("grant user must match independently verified /user and trusted app metadata", async () => {
  const f = await fixture(async (r) =>
    r.url.endsWith("/user")
      ? {
          status: 200,
          body: {
            ...user("bob"),
            user_metadata: { ibs_marker_username: "alice" },
          },
        }
      : undefined,
  );
  const p = await f.prepare((await f.boot()).authRevision);
  const r = await f.login(p);
  expect(r.status).toBe(503);
  expect(f.store.get(f.getCookie().split("=")[1])?.auth).toBeNull();
});
it("rotated token is durable but unusable until /user verification succeeds, including later requests", async () => {
  let clock = 100000;
  let offline = false;
  const f = await fixture(
    async (r) => {
      if (offline && r.url.endsWith("/user"))
        throw Error("PRIVATE verification failure");
      return undefined;
    },
    {},
    () => clock,
  );
  const a = await f.signin((await f.boot()).authRevision);
  clock += 3600000;
  offline = true;
  expect((await f.pull(a.authRevision)).status).toBe(503);
  expect(f.store.get(f.getCookie().split("=")[1])?.auth?.refreshToken).toBe(
    "refresh-alice-rotated",
  );
  expect((await f.pull(a.authRevision)).status).toBe(503);
  expect(f.calls.filter((r) => r.url.includes("tracker_changes"))).toHaveLength(
    0,
  );
  offline = false;
  expect((await f.pull(a.authRevision)).status).toBe(200);
  expect(
    f.calls.filter((r) => r.url.endsWith("grant_type=refresh_token")),
  ).toHaveLength(1);
});
it("old /user success cannot mark newly rotated pending tokens verified", async () => {
  const oldStarted = gate(),
    oldRelease = gate(),
    rotatedStarted = gate(),
    rotatedRelease = gate();
  let holdOld = false;
  const f = await fixture(async (r) => {
    if (
      r.url.endsWith("/user") &&
      r.headers?.Authorization === "Bearer jwt-alice" &&
      holdOld
    ) {
      oldStarted.release();
      await oldRelease.wait;
      return { status: 200, body: user("alice") };
    }
    if (
      r.url.endsWith("/user") &&
      r.headers?.Authorization === "Bearer jwt-alice-rotated"
    ) {
      rotatedStarted.release();
      await rotatedRelease.wait;
      return { status: 503, body: {} };
    }
    if (r.url.includes("tracker_changes"))
      return { status: 401, body: { code: "PGRST301" } };
    return undefined;
  });
  const a = await f.signin((await f.boot()).authRevision);
  holdOld = true;
  const oldSession = f.req("/api/auth/session");
  await oldStarted.wait;
  const refresh = f.pull(a.authRevision);
  await rotatedStarted.wait;
  oldRelease.release();
  await new Promise((r) => setTimeout(r, 25));
  const pending = f.store.get(f.getCookie().split("=")[1])?.auth
    ?.needsVerification;
  rotatedRelease.release();
  const results = await Promise.all([oldSession, refresh]);
  expect(pending).toBe(true);
  expect(results.map((r) => r.status)).toEqual([503, 503]);
});
it("disk failure on logout fails closed before any remote revoke or success", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR!, "bff-diskfail-"));
  dirs.push(dir);
  const path = join(dir, "sessions.enc");
  const disk = createFileSessionStore({ path, encryptionKey: "de".repeat(32) });
  const f = await fixture(undefined, { sessionStore: disk });
  const a = await f.signin((await f.boot()).authRevision);
  rmSync(path);
  mkdirSync(path, { mode: 0o700 });
  const before = f.calls.length;
  const r = await f.req("/api/auth/logout", { authRevision: a.authRevision });
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ ok: false, code: "AUTH_UNAVAILABLE" });
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(f.calls).toHaveLength(before);
  const session = await f.req("/api/auth/session");
  expect(session.status).toBe(503);
  expect(await session.json()).toEqual({ ok: false, code: "AUTH_UNAVAILABLE" });
  expect(f.calls).toHaveLength(before);
});
it("normal BFF polling has its own budget without weakening the original invite-registration limit", async () => {
  const f = await fixture(undefined, {
    rateLimit: undefined,
    inviteCode: "fixture-invite",
  });
  await f.boot();
  for (let i = 0; i < 12; i++)
    expect((await f.req("/api/auth/session")).status).toBe(200);
  for (let i = 0; i < 9; i++)
    expect(
      (
        await f.req("/api/register", {
          username: "alice",
          password: "fixture-only-password",
          inviteCode: "wrong",
        })
      ).status,
    ).toBe(i < 8 ? 403 : 429);
});
it.each(["Alice", "alice", "é", "e\u0301", "用户名"])(
  "preserves exact original UTF-8 username mapping for %s",
  async (username) => {
    const f = await fixture(async (r) => {
      if (r.url.endsWith("grant_type=password")) {
        expect(r.body).toEqual({
          email: usernameToInternalEmail(username),
          password: "fake-only-password",
        });
        return { status: 200, body: token("alice") };
      }
      if (r.url.endsWith("/user"))
        return {
          status: 200,
          body: {
            id: ids.alice,
            app_metadata: { ibs_marker_username: username },
            user_metadata: { ibs_marker_username: "NOT_TRUSTED" },
          },
        };
      return undefined;
    });
    const a = await f.signin((await f.boot()).authRevision, username);
    expect(a.user.displayName).toBe(username);
  },
);
it("expired context requires bootstrap; no other endpoint creates or sets a context cookie", async () => {
  let clock = 1000;
  const store = createMemorySessionStore({ ttlMs: 100, now: () => clock });
  const f = await fixture(undefined, { sessionStore: store }, () => clock);
  const a = await f.boot();
  const cookie = f.getCookie();
  clock = 1100;
  for (const path of [
    "/api/auth/session",
    "/api/sync/pull?cursor=0&limit=100",
  ]) {
    const r = await f.req(path, undefined, {
      "X-Auth-Revision": a.authRevision,
    });
    expect(r.status).toBe(428);
    expect(r.headers.get("set-cookie")).toBeNull();
  }
  const b = await f.boot();
  expect(f.getCookie()).not.toBe(cookie);
  expect(b.authRevision).not.toBe(a.authRevision);
  expect(f.calls).toHaveLength(0);
});
it("late existing-SID bootstrap cannot overwrite new B or set a stale cookie after verification", async () => {
  const started = gate(),
    late = gate();
  let hold = false;
  const f = await fixture(async (r) => {
    if (
      hold &&
      r.url.endsWith("/user") &&
      r.headers?.Authorization === "Bearer jwt-alice"
    ) {
      started.release();
      await late.wait;
    }
    return undefined;
  });
  const a = await f.signin((await f.boot()).authRevision);
  const sid = f.getCookie().split("=")[1];
  const expiresAt = f.store.get(sid)!.expiresAt;
  // A fully generated earlier same-SID response can be delivered late too.
  const earlier = await f.req("/api/auth/bootstrap", {});
  const lateCookie = earlier.headers.get("set-cookie")!.split(";")[0];
  expect(lateCookie).toBe(f.getCookie());
  hold = true;
  const pending = f.req("/api/auth/bootstrap", {});
  await started.wait;
  const b = await f.signin(a.authRevision, "bob");
  late.release();
  const rejected = await pending;
  expect(rejected.status).toBe(409);
  expect(rejected.headers.get("set-cookie")).toBeNull();
  // Reapply the earlier delivered cookie: same SID must still resolve B.
  f.setCookie(lateCookie);
  const restored = await f.req("/api/auth/session");
  expect(restored.headers.get("set-cookie")).toBeNull();
  expect(await restored.json()).toEqual({
    ok: true,
    user: b.user,
    authRevision: b.authRevision,
  });
  expect(f.store.get(sid)!.expiresAt).toBe(expiresAt);
});
it("upstream timeout is bounded and sanitized", async () => {
  const f = await fixture(
    async (r) =>
      r.url.endsWith("grant_type=password")
        ? await new Promise(() => {})
        : undefined,
    { upstreamTimeoutMs: 25 },
  );
  const p = await f.prepare((await f.boot()).authRevision);
  const r = await f.login(p);
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ ok: false, code: "AUTH_UNAVAILABLE" });
});
