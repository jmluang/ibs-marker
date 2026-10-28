import { describe, it, expect, vi } from "vitest";
import { BffTransport } from "../cloud/transport";
import { BffClient } from "../cloud/bff";
import { BFF_BOOTSTRAP_LOCK } from "../domain/backendApi";
import { defaultSettings } from "../domain/types";
import {
  alice,
  bob,
  deferred,
  harness,
  json,
  sharedLocks,
  tick,
} from "./bff-fixture";

describe("BFF transport and controller contract; no provider SDK", () => {
  it("pull/push use exact relative routes and operation body, fixed revision, signal, native receiver", async () => {
    const remote = {
      kind: "settings",
      resourceId: "settings",
      version: 1,
      snapshot: defaultSettings(),
      tombstone: false,
    };
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetcher = function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) {
      expect(this).toBe(globalThis);
      calls.push([String(input), init]);
      return Promise.resolve(
        json(
          String(input).includes("push")
            ? { ok: true, result: { status: "applied", remote } }
            : { ok: true, rows: [{ seq: 7, remote, changeId: "change" }] },
        ),
      );
    } as typeof fetch;
    const t = new BffTransport("captured-A", fetcher);
    const signal = new AbortController().signal;
    expect(await t.pull(3, 50, signal)).toEqual([
      { seq: 7, remote, changeId: "change" },
    ]);
    const operation = {
      kind: "settings" as const,
      resourceId: "settings",
      changeId: crypto.randomUUID(),
      baseVersion: 0,
      snapshot: defaultSettings(),
      tombstone: false,
    };
    expect(await t.push(operation, signal)).toEqual({
      status: "applied",
      remote,
    });
    expect(calls[0][0]).toBe("/api/sync/pull?cursor=3&limit=50");
    expect(calls[1][0]).toBe("/api/sync/push");
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ operation });
    for (const [, init] of calls) {
      expect(init?.credentials).toBe("same-origin");
      expect(init?.signal).toBe(signal);
      expect(new Headers(init?.headers).get("X-Auth-Revision")).toBe(
        "captured-A",
      );
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    }
  });
  it.each(["applied", "conflict"] as const)(
    "preserves push %s semantics and validates remote",
    async (status) => {
      const remote = {
        kind: "settings",
        resourceId: "settings",
        version: 2,
        snapshot: defaultSettings(),
        tombstone: false,
      };
      const t = new BffTransport("A", async () =>
        json({ ok: true, result: { status, remote } }),
      );
      expect(
        (
          await t.push(
            {
              kind: "settings",
              resourceId: "settings",
              changeId: "id",
              baseVersion: 1,
              snapshot: defaultSettings(),
              tombstone: false,
            },
            new AbortController().signal,
          )
        ).status,
      ).toBe(status);
    },
  );
  it.each(["23505", "SESSION_CHANGED", "FORBIDDEN"])(
    "preserves safe code %s without raw details",
    async (code) => {
      const t = new BffTransport("A", async () =>
        json(
          { code, message: "secret" },
          code === "SESSION_CHANGED" ? 409 : 403,
        ),
      );
      await expect(
        t.pull(0, 20, new AbortController().signal),
      ).rejects.toMatchObject({
        code,
        message: code,
        status: code === "SESSION_CHANGED" ? 401 : 403,
      });
    },
  );
  it("rejects malformed remote and unknown raw backend errors", async () => {
    const bad = new BffTransport("A", async () =>
      json({
        ok: true,
        rows: [{ seq: 1, remote: { kind: "settings", version: 0 } }],
      }),
    );
    await expect(bad.pull(0, 20, new AbortController().signal)).rejects.toThrow(
      "INVALID_REMOTE",
    );
    const raw = new BffTransport("A", async () =>
      json({ code: "provider-secret", message: "raw-secret" }, 500),
    );
    await expect(
      raw.pull(0, 20, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      message: "REQUEST_FAILED",
    });
  });
  it("only explicit development local mode skips all HTTP", async () => {
    const h = harness();
    const c = await h.boot({ env: { VITE_APP_MODE: "local" } });
    expect(c.getSnapshot().mode).toBe("local");
    expect(c.store.getSnapshot().namespace).toBe("local");
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("default BFF clears previous local timer/drafts and never automatically imports local data", async () => {
    const h = harness();
    const c = h.create();
    await c.store.activate("local");
    await c.store.startTimer();
    await c.store.saveDraft("private", "draft");
    await c.store.saveSettings({
      ...defaultSettings(),
      foodTemplates: ["local-only"],
    });
    await c.initialize();
    expect(c.store.getSnapshot().namespace).toBeNull();
    expect(c.store.getSnapshot().drafts).toEqual({});
    expect(c.store.getSnapshot().timer).toBeNull();
    await c.signIn("Alice", "password");
    expect(c.store.getSnapshot().settings.foodTemplates).toEqual([]);
    expect(c.store.getSnapshot().outbox).toHaveLength(0);
    await c.enterLocal();
    expect(c.store.getSnapshot().namespace).toBe(`user:${alice.id}`);
  });
  it("logout locks memory before HTTP and retains A's partition for explicit relogin", async () => {
    const h = harness();
    const database = crypto.randomUUID();
    const c = await h.boot({ database });
    await c.signIn("Alice", "password");
    await c.store.saveDraft("private", "A draft");
    await c.store.startTimer();
    h.hooks["/api/auth/logout"] = (_i, f) => {
      expect(c.store.getSnapshot().namespace).toBeNull();
      expect(c.store.getSnapshot().drafts).toEqual({});
      expect(c.store.getSnapshot().timer).toBeNull();
      return f();
    };
    await c.signOut();
    await c.signIn("Bob", "password");
    expect(c.store.getSnapshot().drafts).toEqual({});
    await c.signIn("Alice", "password");
    expect(c.store.getSnapshot().drafts).toEqual({ private: "A draft" });
  });
  it("409 sync revocation maps to auth invalidation, not guest or queue deletion", async () => {
    const h = harness();
    const c = await h.boot();
    await c.signIn("Alice", "password");
    await c.sync();
    h.state.revision = "new-B";
    h.state.user = bob;
    await c.sync();
    expect(c.getSnapshot().mode).toBe("login");
    expect(c.store.getSnapshot().namespace).toBeNull();
  });
  it.each([
    [401, "INVALID_CREDENTIALS", "登录失败，请检查用户名和密码。"],
    [429, "RATE_LIMITED", "请求过于频繁，请稍后再试。"],
    [503, "AUTH_UNAVAILABLE", "暂时无法登录，请稍后重试。"],
    [409, "SESSION_CHANGED", "账号会话已在其他操作中变更，请重新登录。"],
  ])(
    "login status %s is accurately sanitized",
    async (status, code, message) => {
      const h = harness();
      const c = await h.boot();
      h.hooks["/api/auth/login"] = () =>
        json({ code, message: "provider-secret" }, Number(status));
      expect(await c.signIn("Alice", " raw password ")).toBe(false);
      expect(c.getSnapshot()).toMatchObject({ error: message, busy: false });
      const call = h.fetcher.mock.calls.find(([p]) => p === "/api/auth/login")!;
      expect(JSON.parse(String(call[1]?.body))).toMatchObject({
        username: "Alice",
        password: " raw password ",
        authRevision: "rev-1",
        attemptId: "attempt-1",
      });
    },
  );
  it("login network failure is not password failure and invalid username does not send HTTP", async () => {
    const h = harness();
    const c = await h.boot();
    h.fetcher.mockClear();
    await c.signIn(" Alice", "password");
    expect(h.fetcher).not.toHaveBeenCalled();
    h.state.offline = true;
    await c.signIn("Alice", "password");
    expect(c.getSnapshot().error).toBe("登录请求失败，请检查网络。");
  });
  it("failed offline partition loading clears namespace and reports a safe storage error", async () => {
    const h = harness();
    const c = await h.boot();
    vi.spyOn(c.store.adapter, "read").mockRejectedValue(
      new Error("private-raw-storage-error"),
    );
    expect(await c.signIn("Alice", "password")).toBe(false);
    expect(c.store.getSnapshot().namespace).toBeNull();
    expect(c.getSnapshot()).toMatchObject({
      mode: "login",
      busy: false,
      error: "无法打开账号离线存储，请重试。",
    });
  });
  it("switching accounts never uploads or deletes the old account's durable queue", async () => {
    const h = harness();
    const database = crypto.randomUUID();
    const c = await h.boot({ database });
    await c.signIn("Alice", "password");
    await c.sync();
    h.state.offline = true;
    await c.store.saveSettings({
      ...defaultSettings(),
      foodTemplates: ["A private pending"],
    });
    const operation = c.store.getSnapshot().outbox[0];
    await c.signOut();
    h.state.offline = false;
    await c.signIn("Bob", "password");
    await c.sync();
    expect(c.store.getSnapshot().outbox).toEqual([]);
    expect(c.store.getSnapshot().settings.foodTemplates).toEqual([]);
    expect(
      h.fetcher.mock.calls.filter(([p]) => p === "/api/sync/push"),
    ).toHaveLength(0);
    const saved = await c.store.adapter.read(`user:${alice.id}`);
    expect(saved.outbox.map((o) => o.changeId)).toEqual([operation.changeId]);
  });
  it("malformed BFF identity cannot select an offline namespace", async () => {
    const h = harness();
    h.hooks["/api/auth/session"] = () =>
      json({
        ok: true,
        user: { id: "bad", displayName: "Alice" },
        authRevision: "A",
      });
    const c = await h.boot();
    expect(c.store.getSnapshot().namespace).toBeNull();
    expect(c.getSnapshot().mode).toBe("login");
  });
});

describe("cross-tab bootstrap context fencing", () => {
  it("a locked offline shell still reports unsupported secure bootstrap explicitly", async () => {
    const h = harness();
    const c = await h.boot();
    await c.signOut();
    h.fetcher.mockClear();
    h.state.context = false;
    const fresh = await h.boot({ locks: null });
    expect(fresh.getSnapshot().mode).toBe("login");
    expect(fresh.getSnapshot().error).toContain("Web Locks");
    expect(
      h.fetcher.mock.calls.some(([path]) => path === "/api/auth/bootstrap"),
    ).toBe(false);
  });
  it("no Web Locks fails safely only if context creation is required", async () => {
    const h = harness();
    h.state.context = false;
    const client = new BffClient(h.fetcher, null);
    await expect(client.session()).rejects.toMatchObject({
      code: "BOOTSTRAP_UNSUPPORTED",
    });
    expect(
      h.fetcher.mock.calls.some(([p]) => p === "/api/auth/bootstrap"),
    ).toBe(false);
    h.state.context = true;
    expect(await client.session()).toMatchObject({ ok: true, user: null });
  });
  it.each(["cancel", "dispose"] as const)(
    "%s cannot release bootstrap lock early or allow parallel bootstrap",
    async (action) => {
      const h = harness();
      h.state.context = false;
      const { locks, calls } = sharedLocks();
      const gate = deferred<void>();
      let started = false;
      h.hooks["/api/auth/bootstrap"] = async () => {
        started = true;
        await gate.promise;
        h.state.context = true;
        return json({ ok: true, user: h.state.user, authRevision: h.state.revision });
      };
      const a = h.create({ locks });
      const initA = a.initialize();
      await vi.waitFor(() => expect(started).toBe(true));
      action === "cancel" ? a.cancelAuthentication() : a.dispose();
      const b = h.create({ locks });
      const initB = b.initialize();
      await tick();
      expect(
        h.fetcher.mock.calls.filter(([p]) => p === "/api/auth/bootstrap"),
      ).toHaveLength(1);
      expect(b.getSnapshot().mode).toBe("checking");
      gate.resolve();
      await Promise.all([initA, initB]);
      expect(calls).toEqual([BFF_BOOTSTRAP_LOCK, BFF_BOOTSTRAP_LOCK]);
      expect(
        h.fetcher.mock.calls.filter(([p]) => p === "/api/auth/bootstrap"),
      ).toHaveLength(2); // serialized reissue for the second healthy context
      await b.signIn("Bob", "password");
      expect(b.getSnapshot().displayName).toBe("Bob");
      expect(a.store.getSnapshot().namespace).toBeNull();
    },
  );
  it("a context cookie visible at bootstrap headers cannot bypass the still-held body lock", async () => {
    const h = harness();
    h.state.context = false;
    const { locks } = sharedLocks();
    let release!: () => void;
    let held = false;
    h.hooks["/api/auth/bootstrap"] = (_i, fallback) => {
      if (held) return fallback();
      held = true;
      // Browser has applied the stable cookie, but the body is still in flight.
      h.state.context = true;
      return new Response(
        new ReadableStream({
          start(controller) {
            release = () => {
              controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, user: h.state.user, authRevision: h.state.revision })));
              controller.close();
            };
          },
        }),
      );
    };
    const first = new BffClient(h.fetcher, locks).session();
    await vi.waitFor(() => expect(release).toBeDefined());
    let secondReady = false;
    const second = new BffClient(h.fetcher, locks).session().then((value) => {
      secondReady = true;
      return value;
    });
    await tick();
    expect(secondReady).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(secondReady).toBe(true);
  });
  it("holds the bootstrap lock through delayed complete body AND confirmation GET", async () => {
    const h = harness();
    h.state.context = false;
    const { locks } = sharedLocks();
    let release!: () => void;
    let bootstrap = false;
    h.hooks["/api/auth/bootstrap"] = (_i, fallback) => {
      if (bootstrap) return fallback();
      bootstrap = true;
      return new Response(
        new ReadableStream({
          start(controller) {
            release = () => {
              h.state.context = true;
              controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, user: h.state.user, authRevision: h.state.revision })));
              controller.close();
            };
          },
        }),
      );
    };
    const a = h.create({ locks });
    const first = a.initialize();
    await vi.waitFor(() => expect(bootstrap).toBe(true));
    a.cancelAuthentication();
    const b = h.create({ locks });
    const second = b.initialize();
    await tick();
    expect(
      h.fetcher.mock.calls.filter(([p]) => p === "/api/auth/bootstrap"),
    ).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    const paths = h.fetcher.mock.calls.map(([p]) => p);
    const bootstrapIndex = paths.indexOf("/api/auth/bootstrap");
    expect(
      paths.slice(bootstrapIndex + 1).filter((p) => p === "/api/auth/session")
        .length,
    ).toBeGreaterThanOrEqual(2);
    expect(b.getSnapshot().mode).toBe("login");
  });
  it("context-required error consumes a delayed body before entering bootstrap", async () => {
    const h = harness();
    h.state.context = false;
    const { locks } = sharedLocks();
    const body = deferred<unknown>();
    let calls = 0;
    h.hooks["/api/auth/session"] = (_i, f) => {
      if (calls++ > 0) return f();
      const response = json({}, 428);
      response.json = () => body.promise;
      return response;
    };
    const pending = new BffClient(h.fetcher, locks).session();
    await tick();
    expect(
      h.fetcher.mock.calls.some(([p]) => p === "/api/auth/bootstrap"),
    ).toBe(false);
    body.resolve({ code: "SESSION_CONTEXT_REQUIRED" });
    expect(await pending).toMatchObject({ ok: true, user: null });
  });
});
