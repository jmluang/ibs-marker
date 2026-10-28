import { afterEach, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { createApplication } from "../../server/app.ts";
import type { ServerConfig } from "../../server/app.ts";
import { createMemorySessionStore } from "../../server/sessionStore.ts";
import { defaultSettings } from "../domain/types.ts";
import type { OutboxOperation } from "../domain/types.ts";
import type {
  JsonRequest,
  JsonRequestInput,
} from "../../server/curlTransport.ts";
const origin = "https://app.fixture.invalid";
const uid = "f0000000-0000-4000-8000-000000000001";
const id = "a0000000-0000-4000-8000-000000000001";
const changeId = "b0000000-0000-4000-8000-000000000001";
const date = "2026-10-20T12:00:00.000Z";
const servers: ReturnType<typeof createApplication>[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
const symptom = () => ({
  id,
  kind: "symptom" as const,
  occurredAt: date,
  createdAt: date,
  updatedAt: date,
  estimatedTime: false,
  deletedAt: null,
  note: "",
  context: "",
  discomfort: {
    status: "reported" as const,
    symptoms: [{ name: "pain" as const, severity: "mild" as const }],
  },
});
const meal = () => ({
  ...symptom(),
  kind: "meal" as const,
  status: "eaten",
  slot: "lunch",
  foods: "rice",
  tags: ["warm"],
  portion: "medium",
});
function op(kind = "symptom"): OutboxOperation {
  const e =
    kind === "meal"
      ? (() => {
          const { context: _, discomfort: __, ...m } = meal();
          return m;
        })()
      : symptom();
  return {
    kind: "entry",
    resourceId: id,
    changeId,
    baseVersion: 0,
    snapshot: e as OutboxOperation["snapshot"],
    tombstone: false,
  };
}
const remote = (o = op()) => ({
  kind: o.kind,
  resourceId: o.resourceId,
  version: 1,
  snapshot: o.snapshot,
  tombstone: o.tombstone,
});
async function fixture(
  handler?: JsonRequest,
  options: Partial<ServerConfig> = {},
) {
  const calls: JsonRequestInput[] = [];
  const store = createMemorySessionStore();
  const { sid, context } = store.create();
  store.cas(sid, context.authRevision, (c) => {
    c.auth = {
      user: { id: uid, displayName: "alice" },
      accessToken: "USER_JWT_FIXTURE",
      refreshToken: "USER_REFRESH_FIXTURE",
      expiresAt: Date.now() + 3600000,
    };
  });
  const server = createApplication(
    {
      publicOrigin: origin,
      supabaseUrl: "https://provider.fixture.invalid",
      supabasePublicKey: "PUBLIC_FIXTURE",
      supabaseSecretKey: "ADMIN_MUST_NEVER_APPEAR",
      sessionStore: store,
      rateLimit: { perIp: 1000, global: 1000, maxIps: 100, windowMs: 60000 },
      ...options,
    },
    async (r) => {
      calls.push(r);
      if (handler) return handler(r);
      const b = r.body as Record<string, unknown>;
      return {
        status: 200,
        body:
          r.method === "GET"
            ? [{ seq: 1, resource: remote(), change_id: changeId }]
            : {
                status: "applied",
                remote: remote({
                  kind: b.p_kind,
                  resourceId: b.p_resource_id,
                  snapshot: b.p_snapshot,
                  tombstone: b.p_tombstone,
                } as OutboxOperation),
              },
      };
    },
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw Error();
  const base = `http://127.0.0.1:${a.port}`;
  const req = (
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        Cookie: `__Host-ibs_session=${sid}`,
        "X-Auth-Revision": context.authRevision,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { base, req, calls, store, sid, revision: context.authRevision };
}
it("pull uses fixed projection/order and public apikey + user JWT, never admin credentials", async () => {
  const f = await fixture();
  const r = await f.req("/api/sync/pull?cursor=0&limit=100");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({
    ok: true,
    rows: [{ seq: 1, remote: remote(), changeId }],
  });
  expect(f.calls).toEqual([
    {
      method: "GET",
      url: "https://provider.fixture.invalid/rest/v1/tracker_changes?select=seq,resource,change_id&seq=gt.0&order=seq.asc&limit=100",
      headers: {
        apikey: "PUBLIC_FIXTURE",
        Authorization: "Bearer USER_JWT_FIXTURE",
      },
      signal: expect.any(AbortSignal),
    },
  ]);
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(r.headers.get("access-control-allow-origin")).toBeNull();
  expect(r.headers.get("content-security-policy")).toContain(
    "connect-src 'self'",
  );
});
it.each(["applied", "conflict"])(
  "push fixed RPC returns %s with only canonical data",
  async (status) => {
    const operation = op();
    const f = await fixture(async () => ({
      status: 200,
      body: {
        status,
        remote: remote(operation),
        internal: "PRIVATE_PROVIDER_FIELD",
      },
    }));
    const r = await f.req("/api/sync/push", { operation });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ok: true,
      result: { status, remote: remote(operation) },
    });
    expect(f.calls[0]).toEqual({
      method: "POST",
      url: "https://provider.fixture.invalid/rest/v1/rpc/tracker_apply_change",
      headers: {
        apikey: "PUBLIC_FIXTURE",
        Authorization: "Bearer USER_JWT_FIXTURE",
      },
      body: {
        p_change_id: changeId,
        p_kind: "entry",
        p_resource_id: id,
        p_base_version: 0,
        p_snapshot: operation.snapshot,
        p_tombstone: false,
      },
      signal: expect.any(AbortSignal),
    });
  },
);
it("accepts a large legitimate snapshot (>8KB, <262144 bytes) and settings with dynamic allowed snoozes", async () => {
  const f = await fixture();
  const operation = op();
  if ("note" in operation.snapshot)
    operation.snapshot.note = "界".repeat(12000);
  expect((await f.req("/api/sync/push", { operation })).status).toBe(200);
  const settings = defaultSettings();
  settings.snoozes["2026-10-21:lunch"] = date;
  const s: OutboxOperation = {
    kind: "settings",
    resourceId: "settings",
    changeId,
    baseVersion: 1,
    snapshot: settings,
    tombstone: false,
  };
  expect((await f.req("/api/sync/push", { operation: s })).status).toBe(200);
  expect(f.calls).toHaveLength(2);
});
function toiletOperation(): Record<string, any> {
  const { context: _, ...common } = symptom();
  return {
    kind: "entry",
    resourceId: id,
    changeId,
    baseVersion: 0,
    tombstone: false,
    snapshot: {
      ...common,
      kind: "toilet",
      result: "passed",
      stoolForms: [4],
      startedAt: null,
      endedAt: null,
      durationSource: "unknown",
      estimatedDurationMinutes: null,
      relief: "unknown",
    },
  };
}
it.each(["unknown", "estimated", "timer", "deleted"])(
  "accepts exact toilet variant %s",
  async (mode) => {
    const f = await fixture();
    const operation = toiletOperation();
    if (mode === "estimated") {
      operation.snapshot.durationSource = "estimated";
      operation.snapshot.estimatedDurationMinutes = 5;
    }
    if (mode === "timer") {
      operation.snapshot.durationSource = "timer";
      operation.snapshot.startedAt = date;
      operation.snapshot.endedAt = date;
    }
    if (mode === "deleted") {
      operation.snapshot.deletedAt = date;
      operation.tombstone = true;
    }
    expect((await f.req("/api/sync/push", { operation })).status).toBe(200);
  },
);
it.each([
  "form",
  "forms-null",
  "duration-string",
  "duration-negative",
  "timer-incomplete",
  "duration-order",
  "relief",
  "result-mismatch",
  "unknown-field",
  "null-discomfort",
])("rejects malformed toilet %s without upstream", async (mode) => {
  const f = await fixture();
  const operation = toiletOperation();
  const e = operation.snapshot;
  if (mode === "form") e.stoolForms = [8];
  if (mode === "forms-null") e.stoolForms = null;
  if (mode === "duration-string") {
    e.durationSource = "estimated";
    e.estimatedDurationMinutes = "5";
  }
  if (mode === "duration-negative") {
    e.durationSource = "estimated";
    e.estimatedDurationMinutes = -1;
  }
  if (mode === "timer-incomplete") e.durationSource = "timer";
  if (mode === "duration-order") {
    e.startedAt = "2026-10-21T12:00:00Z";
    e.endedAt = date;
  }
  if (mode === "relief") e.relief = "bad";
  if (mode === "result-mismatch") e.result = "none";
  if (mode === "unknown-field") e.timerId = "private";
  if (mode === "null-discomfort") e.discomfort = null;
  const r = await f.req("/api/sync/push", { operation });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ ok: false, code: "INVALID_OPERATION" });
  expect(f.calls).toHaveLength(0);
});
const malformed: [string, (o: Record<string, any>) => void][] = [
  [
    "unknown top field",
    (o) => {
      o.owner_id = uid;
    },
  ],
  [
    "unknown snapshot field",
    (o) => {
      o.snapshot.owner_id = uid;
    },
  ],
  [
    "unknown symptom field",
    (o) => {
      o.snapshot.discomfort.symptoms[0].private = "x";
    },
  ],
  [
    "null symptom",
    (o) => {
      o.snapshot.discomfort.symptoms = [null];
    },
  ],
  [
    "context object",
    (o) => {
      o.snapshot.context = {};
    },
  ],
  [
    "context array",
    (o) => {
      o.snapshot.context = [];
    },
  ],
  [
    "context missing",
    (o) => {
      delete o.snapshot.context;
    },
  ],
  [
    "discomfort null",
    (o) => {
      o.snapshot.discomfort = null;
    },
  ],
  [
    "unknown discomfort",
    (o) => {
      o.snapshot.discomfort.foo = 1;
    },
  ],
  [
    "wrong severity",
    (o) => {
      o.snapshot.discomfort.symptoms[0].severity = "bad";
    },
  ],
  [
    "reported empty",
    (o) => {
      o.snapshot.discomfort.symptoms = [];
    },
  ],
  [
    "unknown kind",
    (o) => {
      o.snapshot.kind = "other";
    },
  ],
  [
    "invalid UUID",
    (o) => {
      o.changeId = "uuid";
    },
  ],
  [
    "id mismatch",
    (o) => {
      o.resourceId = uid;
    },
  ],
  [
    "invalid date",
    (o) => {
      o.snapshot.occurredAt = "yesterday";
    },
  ],
  [
    "impossible date",
    (o) => {
      o.snapshot.occurredAt = "2026-02-30T12:00:00Z";
    },
  ],
  [
    "invalid estimated boolean",
    (o) => {
      o.snapshot.estimatedTime = "true";
    },
  ],
  [
    "tombstone mismatch",
    (o) => {
      o.tombstone = true;
    },
  ],
  [
    "deletedAt type",
    (o) => {
      o.snapshot.deletedAt = false;
    },
  ],
  [
    "negative version",
    (o) => {
      o.baseVersion = -1;
    },
  ],
  [
    "unsafe version",
    (o) => {
      o.baseVersion = 9007199254740992;
    },
  ],
  [
    "string version",
    (o) => {
      o.baseVersion = "1";
    },
  ],
  [
    "nonstring note",
    (o) => {
      o.snapshot.note = 1;
    },
  ],
  [
    "array >1000",
    (o) => {
      o.snapshot.discomfort.symptoms = Array.from({ length: 1001 }, () => ({
        name: "pain",
        severity: "mild",
      }));
    },
  ],
];
it.each(malformed)(
  "strictly rejects malformed operation: %s without upstream",
  async (_name, mutate) => {
    const f = await fixture();
    const operation = structuredClone(op()) as unknown as Record<string, any>;
    mutate(operation);
    const r = await f.req("/api/sync/push", { operation });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, code: "INVALID_OPERATION" });
    expect(f.calls).toHaveLength(0);
  },
);
it.each([
  "tag-object",
  "template-object",
  "meal-unknown",
  "settings-unknown",
  "snooze-invalid",
  "snoozes-array",
  "enabled-string",
  "settings-tombstone",
  "settings-resource",
])("rejects strict nested meal/settings: %s", async (mode) => {
  const f = await fixture();
  let operation: Record<string, any> = structuredClone(op("meal"));
  if (mode.startsWith("tag")) operation.snapshot.tags = [{}];
  else if (mode === "meal-unknown") operation.snapshot.portion = "huge";
  else {
    operation = {
      kind: "settings",
      resourceId: "settings",
      changeId,
      baseVersion: 0,
      snapshot: defaultSettings(),
      tombstone: false,
    };
    if (mode === "template-object") operation.snapshot.foodTemplates = [{}];
    if (mode === "settings-unknown") operation.snapshot.extra = "x";
    if (mode === "snooze-invalid")
      operation.snapshot.snoozes = { arbitrary: date };
    if (mode === "snoozes-array") operation.snapshot.snoozes = [];
    if (mode === "enabled-string")
      operation.snapshot.meals.breakfast.enabled = "true";
    if (mode === "settings-tombstone") operation.tombstone = true;
    if (mode === "settings-resource") operation.resourceId = id;
  }
  const r = await f.req("/api/sync/push", { operation });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ ok: false, code: "INVALID_OPERATION" });
  expect(f.calls).toHaveLength(0);
});
it.each([
  "",
  "?cursor=0",
  "?cursor=0&limit=0",
  "?cursor=0&limit=101",
  "?cursor=-1&limit=10",
  "?cursor=1.1&limit=10",
  "?cursor=9007199254740992&limit=10",
  "?cursor=0&limit=10&owner=anything",
  "?cursor=0&cursor=1&limit=10",
  "?cursor=0&limit=1&limit=2",
])("rejects bad pull query %s before upstream", async (query) => {
  const f = await fixture();
  const r = await f.req("/api/sync/pull" + query);
  expect([400, 404]).toContain(r.status);
  expect(f.calls).toHaveLength(0);
});
it("missing context is 428; unknown/duplicate cookies never create one; absent/wrong revision is 409; anonymous current is 401", async () => {
  const f = await fixture();
  for (const cookie of [
    "",
    `__Host-ibs_session=${"a".repeat(64)}`,
    `__Host-ibs_session=${f.sid}; __Host-ibs_session=${f.sid}`,
  ]) {
    const r = await f.req("/api/sync/pull?cursor=0&limit=100", undefined, {
      Cookie: cookie,
    });
    expect(r.status).toBe(428);
    expect(r.headers.get("set-cookie")).toBeNull();
  }
  for (const revision of ["", "wrong"])
    expect(
      (
        await f.req("/api/sync/pull?cursor=0&limit=100", undefined, {
          "X-Auth-Revision": revision,
        })
      ).status,
    ).toBe(409);
  f.store.cas(f.sid, f.revision, (c) => {
    c.auth = null;
  });
  expect((await f.req("/api/sync/pull?cursor=0&limit=100")).status).toBe(401);
  expect(f.calls).toHaveLength(0);
});
it.each([
  [403, "42501", 403, "FORBIDDEN"],
  [409, "23505", 409, "23505"],
  [400, "22023", 503, "SYNC_UNAVAILABLE"],
  [503, "PRIVATE", 503, "SYNC_UNAVAILABLE"],
  [429, "PRIVATE", 429, "RATE_LIMITED"],
])("sanitizes sync provider %s / %s", async (status, code, expected, safe) => {
  const f = await fixture(async () => ({
    status: status as number,
    body: { code, message: "PRIVATE SQL URL JWT ADMIN" },
  }));
  const r = await f.req("/api/sync/push", { operation: op() });
  expect(r.status).toBe(expected);
  expect(await r.json()).toEqual({ ok: false, code: safe });
  expect(r.headers.get("set-cookie")).toBeNull();
});
it("ignores provider top-level extra columns but rejects nested private data rather than leaking it", async () => {
  const f = await fixture(async () => ({
    status: 200,
    body: [
      {
        seq: 1,
        change_id: changeId,
        owner_id: uid,
        resource: { ...remote(), private: "PRIVATE_SECRET" },
      },
    ],
  }));
  const r = await f.req("/api/sync/pull?cursor=0&limit=100");
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ ok: false, code: "SYNC_UNAVAILABLE" });
});
it("strict Origin, fetch-site, JSON, body size and timeout boundaries never call provider", async () => {
  const f = await fixture(undefined, { bodyTimeoutMs: 30 });
  for (const headers of [
    { Origin: "null" },
    { Origin: "https://foreign.invalid" },
    { Origin: origin + "/" },
    { "Sec-Fetch-Site": "cross-site" },
  ] as Record<string, string>[]) {
    for (const path of [
      "/api/auth/session",
      "/api/sync/pull?cursor=0&limit=100",
    ]) {
      const r = await f.req(path, undefined, headers);
      expect(r.status).toBe(403);
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
  }
  const operation = op();
  if ("note" in operation.snapshot)
    operation.snapshot.note = "x".repeat(263000);
  expect((await f.req("/api/sync/push", { operation })).status).toBe(413);
  expect(
    (
      await f.req(
        "/api/sync/push",
        { operation: op() },
        { "Content-Type": "text/plain" },
      )
    ).status,
  ).toBe(415);
  const status = await new Promise<number>((resolve, reject) => {
    const r = httpRequest(
      f.base + "/api/sync/push",
      {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "Content-Length": "100",
          Cookie: `__Host-ibs_session=${f.sid}`,
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
  expect(f.calls).toHaveLength(0);
});
it("BFF shares bounded IP/global rate budget, including rejected requests", async () => {
  const f = await fixture(undefined, {
    trustedProxyIPs: ["127.0.0.1"],
    rateLimit: { perIp: 2, global: 3, maxIps: 2, windowMs: 60000 },
  });
  expect(
    (
      await f.req("/api/auth/session", undefined, {
        Origin: "https://evil.invalid",
        "CF-Connecting-IP": "1.2.3.4",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.req("/api/auth/session", undefined, {
        "CF-Connecting-IP": "1.2.3.4",
      })
    ).status,
  ).toBe(503); // /user is deliberately unsupported by this sync-only provider fixture.
  expect(
    (
      await f.req("/api/auth/session", undefined, {
        "CF-Connecting-IP": "1.2.3.4",
      })
    ).status,
  ).toBe(429);
  expect(
    (
      await f.req("/api/auth/session", undefined, {
        "CF-Connecting-IP": "2.3.4.5",
      })
    ).status,
  ).toBe(429);
});
