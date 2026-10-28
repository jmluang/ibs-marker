import { describe, expect, it, vi } from "vitest";
import { AUTH_LOCK_KEY, AuthLock } from "../cloud/authLock";
import { alice, bob, deferred, harness, json, tick } from "./bff-fixture";

describe("BFF revision-bound auth persistence and lifecycle", () => {
  it.each([
    [409, "SESSION_CHANGED"],
    [401, "UNAUTHENTICATED"],
    [403, "provider-secret-unknown-403"],
  ] as const)("sync %s durably locks revoked A across offline reload without deleting its outbox", async (status, code) => {
    const h = harness();
    const database = crypto.randomUUID();
    const c = await h.boot({ database });
    await c.signIn("Alice", "password");
    await c.sync();
    h.state.offline = true;
    await c.store.saveSettings({ ...c.store.getSnapshot().settings, foodTemplates: ["A pending"] });
    const outbox = c.store.getSnapshot().outbox;
    const revision = h.state.revision;
    h.state.offline = false;
    h.state.revision = "external-B";
    h.state.user = bob;
    if (status !== 409) h.hooks["/api/sync/pull"] = () => json({ code }, status);
    await c.sync();
    expect(c.getSnapshot().mode).toBe("login");
    expect(c.store.getSnapshot().namespace).toBeNull();
    expect(JSON.parse(h.data.get(AUTH_LOCK_KEY)!)).toMatchObject({ locked: true, authRevision: revision });
    expect(h.state.user).toEqual(bob);
    expect(h.fetcher.mock.calls.filter(([p]) => p === "/api/auth/logout")).toHaveLength(0);
    h.state.offline = true;
    c.dispose();
    const fresh = await h.boot({ database });
    expect(fresh.getSnapshot().mode).toBe("login");
    expect(fresh.store.getSnapshot().namespace).toBeNull();
    expect((await fresh.store.adapter.read(`user:${alice.id}`)).outbox).toEqual(outbox);
  });
  it("auth failure uses current matching metadata stamp after a legitimate refresh", async () => {
    const h = harness();
    const c = await h.boot();
    await c.signIn("Alice", "password");
    await c.sync();
    const metadata = c.authLock.read()!;
    const peer = new AuthLock(h.storage, h.hub.endpoint());
    const refreshed = peer.write({ ...metadata, user: { ...alice, displayName: "Alice updated" } }, metadata.stamp)!;
    expect(c.getSnapshot().mode).toBe("cloud");
    h.state.revision = "external-B";
    h.state.user = bob;
    await c.sync();
    expect(JSON.parse(h.data.get(AUTH_LOCK_KEY)!)).toMatchObject({ locked: true, authRevision: metadata.authRevision, user: refreshed.user });
    peer.close();
  });
  it.each([false, true])("late A failure cannot overwrite published B metadata (locked=%s)", async (locked) => {
    const h = harness();
    // Model delayed cross-tab notifications, not an already-cancelled engine.
    const a = await h.boot({ authEvents: { subscribe: () => () => {}, publish: () => {} } });
    await a.signIn("Alice", "password");
    await a.sync();
    const gate = deferred<Response>();
    let started = false;
    h.hooks["/api/sync/pull"] = () => { started = true; return gate.promise; };
    const old = a.sync();
    await vi.waitFor(() => expect(started).toBe(true));
    delete h.hooks["/api/sync/pull"];
    const b = await h.boot();
    await b.signIn("Bob", "password");
    await b.sync();
    if (locked) { h.state.offline = true; await b.signOut(); h.state.offline = false; }
    const metadata = h.data.get(AUTH_LOCK_KEY);
    const logoutCount = h.fetcher.mock.calls.filter(([p]) => p === "/api/auth/logout").length;
    gate.resolve(json({ code: "SESSION_CHANGED" }, 409));
    await old;
    expect(a.store.getSnapshot().namespace).toBeNull();
    expect(h.data.get(AUTH_LOCK_KEY)).toBe(metadata);
    expect(h.state.user).toEqual(bob);
    expect(h.fetcher.mock.calls.filter(([p]) => p === "/api/auth/logout")).toHaveLength(logoutCount);
    expect(b.getSnapshot().mode).toBe(locked ? "login" : "cloud");
  });
  it("auth failure locks UI before a throwing durable write and explicitly reports the failed lock", async () => {
    const h = harness();
    const c = await h.boot();
    await c.signIn("Alice", "password");
    await c.sync();
    const before = h.data.get(AUTH_LOCK_KEY);
    const atWrite: Array<{ mode: string; displayName: string | null; namespace: string | null }> = [];
    const write = vi.spyOn(h.storage, "setItem").mockImplementation(() => {
      atWrite.push({
        mode: c.getSnapshot().mode,
        displayName: c.getSnapshot().displayName,
        namespace: c.store.getSnapshot().namespace,
      });
      throw new Error("secret-storage-detail");
    });
    h.state.revision = "external-B";
    h.state.user = bob;
    await c.sync();
    expect(write).toHaveBeenCalled();
    expect(atWrite).toEqual([{ mode: "login", displayName: null, namespace: null }]);
    expect(c.authLock.durable).toBe(false);
    expect(c.getSnapshot().error).toMatch(/持久化.*锁定失败/);
    expect(c.getSnapshot().error).not.toContain("secret-storage-detail");
    expect(h.data.get(AUTH_LOCK_KEY)).toBe(before);
  });
  it.each(["cancel", "signOut", "dispose"] as const)(
    "%s fences late success including refresh",
    async (action) => {
      const h = harness();
      const c = await h.boot();
      const delayed = deferred<Response>();
      let committed: Response | undefined;
      h.hooks["/api/auth/login"] = (_init, fallback) => {
        committed = fallback();
        return delayed.promise;
      };
      const pending = c.signIn("Alice", "password");
      await vi.waitFor(() => expect(committed).toBeDefined());
      const stop =
        action === "cancel"
          ? c.cancelAuthentication()
          : action === "signOut"
            ? c.signOut()
            : c.dispose();
      expect(c.getSnapshot().mode).toBe("login");
      expect(c.store.getSnapshot().namespace).toBeNull();
      delayed.resolve(committed!);
      await Promise.all([pending, stop]);
      expect(c.store.getSnapshot().namespace).toBeNull();
      expect((await h.boot()).getSnapshot().mode).toBe("login");
      expect(JSON.parse(h.data.get(AUTH_LOCK_KEY)!).locked).toBe(true);
    },
  );
  it.each(["cancel", "signOut"] as const)(
    "%s: B succeeds before late A and old cleanup cannot erase B",
    async (action) => {
      const h = harness();
      const c = await h.boot();
      const delayed = deferred<Response>();
      let committed: Response | undefined;
      h.hooks["/api/auth/login"] = (init, fallback) =>
        JSON.parse(String(init.body)).username === "Alice"
          ? ((committed = fallback()), delayed.promise)
          : fallback();
      const old = c.signIn("Alice", "same-password");
      await vi.waitFor(() => expect(committed).toBeDefined());
      const stop = action === "cancel" ? c.cancelAuthentication() : c.signOut();
      expect(await c.signIn("Bob", "same-password")).toBe(true);
      const bMetadata = h.data.get(AUTH_LOCK_KEY);
      const bRevision = h.state.revision;
      delayed.resolve(committed!);
      await Promise.all([old, stop]);
      expect(h.state.user).toEqual(bob);
      expect(h.state.revision).toBe(bRevision);
      expect(h.data.get(AUTH_LOCK_KEY)).toBe(bMetadata);
      expect(c.store.getSnapshot().namespace).toBe(`user:${bob.id}`);
      expect((await h.boot()).store.getSnapshot().namespace).toBe(
        `user:${bob.id}`,
      );
    },
  );
  it("buffers delayed login bodies and rejects them after cancellation", async () => {
    const h = harness();
    const c = await h.boot();
    let release!: () => void;
    h.hooks["/api/auth/login"] = (_init, fallback) => {
      const result = fallback();
      return new Response(
        new ReadableStream({
          start(controller) {
            release = async () => {
              controller.enqueue(new TextEncoder().encode(await result.text()));
              controller.close();
            };
          },
        }),
      );
    };
    const login = c.signIn("Alice", "password");
    await vi.waitFor(() => expect(release).toBeDefined());
    c.cancelAuthentication();
    release();
    await login;
    expect(c.getSnapshot().mode).toBe("login");
    expect((await h.boot()).getSnapshot().mode).toBe("login");
  });
  it("cancellation while prepare is pending fences its returned generation before login", async () => {
    const h = harness();
    const c = await h.boot();
    const gate = deferred<Response>();
    let prepared: Response | undefined;
    h.hooks["/api/auth/prepare"] = (_init, fallback) => {
      prepared = fallback();
      return gate.promise;
    };
    const pending = c.signIn("Alice", "password");
    await vi.waitFor(() => expect(prepared).toBeDefined());
    c.cancelAuthentication();
    gate.resolve(prepared!);
    await pending;
    expect(
      h.fetcher.mock.calls.some(([path]) => path === "/api/auth/login"),
    ).toBe(false);
    expect((await h.boot()).store.getSnapshot().namespace).toBeNull();
  });
  it("cancellation before session response prevents any prepare/login", async () => {
    const h = harness();
    const c = await h.boot();
    const gate = deferred<Response>();
    h.hooks["/api/auth/session"] = () => gate.promise;
    const old = c.signIn("Alice", "password");
    c.cancelAuthentication();
    gate.resolve(
      json({ ok: true, user: null, authRevision: h.state.revision }),
    );
    await old;
    expect(
      h.fetcher.mock.calls.some(([path]) => path === "/api/auth/prepare"),
    ).toBe(false);
  });
  it("offline logout is durable across reload and retries only the captured revision", async () => {
    const h = harness();
    const c = await h.boot();
    await c.signIn("Alice", "password");
    const revision = h.state.revision;
    h.state.offline = true;
    await c.signOut();
    expect(JSON.parse(h.data.get(AUTH_LOCK_KEY)!)).toMatchObject({
      locked: true,
      pendingLogout: revision,
    });
    const fresh = await h.boot();
    expect(fresh.getSnapshot().mode).toBe("login");
    expect(fresh.store.getSnapshot().namespace).toBeNull();
    h.state.offline = false;
    await fresh.sync();
    const logouts = h.fetcher.mock.calls.filter(
      ([path]) => path === "/api/auth/logout",
    );
    expect(
      logouts.every(
        ([, init]) => JSON.parse(String(init?.body)).authRevision === revision,
      ),
    ).toBe(true);
    expect(h.state.user).toBeNull();
    expect(JSON.parse(h.data.get(AUTH_LOCK_KEY)!).pendingLogout).toBeNull();
  });
  it("a pending old logout is discarded when server has B, never upgraded to B", async () => {
    const h = harness();
    const c = await h.boot();
    await c.signIn("Alice", "password");
    const aRevision = h.state.revision;
    h.state.offline = true;
    await c.signOut();
    h.state.offline = false;
    h.state.revision = "external-B";
    h.state.user = bob;
    await c.sync();
    expect(h.state.user).toEqual(bob);
    expect(h.state.revision).toBe("external-B");
    expect(JSON.parse(h.data.get(AUTH_LOCK_KEY)!).pendingLogout).toBeNull();
    expect(
      h.fetcher.mock.calls
        .filter(([path]) => path === "/api/auth/logout")
        .every(
          ([, init]) =>
            JSON.parse(String(init?.body)).authRevision === aRevision,
        ),
    ).toBe(true);
    expect((await h.boot()).getSnapshot().mode).toBe("login");
  });
  it("old pending retry response cannot overwrite accepted B metadata", async () => {
    const h = harness();
    const c = await h.boot();
    await c.signIn("Alice", "password");
    const gate = deferred<Response>();
    let old: Response | undefined;
    h.hooks["/api/auth/logout"] = (_i, f) => {
      old = f();
      return gate.promise;
    };
    const logout = c.signOut();
    await vi.waitFor(() => expect(old).toBeDefined());
    await c.signIn("Bob", "password");
    const metadata = h.data.get(AUTH_LOCK_KEY);
    gate.resolve(old!);
    await logout;
    expect(h.data.get(AUTH_LOCK_KEY)).toBe(metadata);
    expect(c.getSnapshot().displayName).toBe("Bob");
  });
  it("same-user offline shell restores records and queue but never an unverified user", async () => {
    const h = harness();
    const database = crypto.randomUUID();
    const c = await h.boot({ database });
    await c.signIn("Alice", "password");
    await c.sync();
    h.state.offline = true;
    await c.store.saveDraft("private", "draft");
    await c.store.saveSettings({
      ...c.store.getSnapshot().settings,
      foodTemplates: ["pending"],
    });
    c.dispose();
    const fresh = await h.boot({ database });
    expect(fresh.store.getSnapshot().namespace).toBe(`user:${alice.id}`);
    expect(fresh.store.getSnapshot().drafts).toEqual({ private: "draft" });
    expect(fresh.store.getSnapshot().outbox).toHaveLength(1);
    const unverified = harness();
    unverified.state.offline = true;
    expect((await unverified.boot()).getSnapshot().mode).toBe("login");
  });
  it("initial failed write probe disables cached offline restoration", async () => {
    const h = harness();
    const c = await h.boot();
    await c.signIn("Alice", "password");
    h.state.offline = true;
    vi.spyOn(h.storage, "setItem").mockImplementation(() => {
      throw new Error("secret");
    });
    const fresh = await h.boot();
    expect(fresh.authLock.durable).toBe(false);
    expect(fresh.getSnapshot().mode).toBe("login");
    expect(fresh.store.getSnapshot().namespace).toBeNull();
  });
  it("storage write failure locks namespace before write, reports cleanup failure and never claims durable", async () => {
    const h = harness();
    const c = await h.boot();
    await c.signIn("Alice", "password");
    await c.store.saveDraft("sensitive", "private");
    await c.store.startTimer();
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    vi.spyOn(h.storage, "setItem").mockImplementation(() => {
      expect(c.store.getSnapshot().namespace).toBeNull();
      expect(c.getSnapshot().displayName).toBeNull();
      throw new Error("provider-secret");
    });
    await c.signOut();
    expect(c.store.getSnapshot().drafts).toEqual({});
    expect(c.store.getSnapshot().timer).toBeNull();
    expect(c.getSnapshot().error).toMatch(/持久化.*清理失败/);
    expect(c.getSnapshot().error).not.toContain("provider-secret");
    expect(c.authLock.durable).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
  it("dispose detaches events/listeners, locks memory and fences late completion despite storage failure", async () => {
    const h = harness();
    const c = await h.boot();
    const delayed = deferred<Response>();
    let response: Response | undefined;
    h.hooks["/api/auth/login"] = (_i, f) => {
      response = f();
      return delayed.promise;
    };
    const login = c.signIn("Alice", "password");
    await vi.waitFor(() => expect(response).toBeDefined());
    vi.spyOn(h.storage, "setItem").mockImplementation(() => {
      throw new Error("secret");
    });
    const listener = vi.fn();
    c.subscribe(listener);
    expect(() => c.dispose()).not.toThrow();
    listener.mockClear();
    delayed.resolve(response!);
    await login;
    await c.signIn("Bob", "password");
    expect(c.store.getSnapshot().namespace).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });
  it("cross-tab new revision immediately cancels old sync and clears namespace", async () => {
    const h = harness();
    const a = await h.boot();
    await a.signIn("Alice", "password");
    await a.sync();
    const delayed = deferred<Response>();
    let signal: AbortSignal | undefined;
    h.hooks["/api/sync/pull"] = (init) => {
      signal = init.signal!;
      return delayed.promise;
    };
    const pending = a.sync();
    await vi.waitFor(() => expect(signal).toBeDefined());
    const oldSignal = signal;
    const b = await h.boot();
    expect(a.getSnapshot().mode).toBe("cloud");
    delete h.hooks["/api/sync/pull"];
    await b.signIn("Bob", "password");
    expect(oldSignal?.aborted).toBe(true);
    delayed.resolve(json({ ok: true, rows: [] }));
    await pending;
    expect(a.store.getSnapshot().namespace).toBeNull();
    expect(b.store.getSnapshot().namespace).toBe(`user:${bob.id}`);
    const pulls = h.fetcher.mock.calls.filter(([path]) =>
      String(path).startsWith("/api/sync/pull"),
    );
    expect(new Headers(pulls.at(-1)![1]?.headers).get("X-Auth-Revision")).toBe(
      h.state.revision,
    );
  });
  it("cross-tab logout lock clears visible A even when logout is offline", async () => {
    const h = harness();
    const a = await h.boot();
    await a.signIn("Alice", "password");
    const b = await h.boot();
    await a.enterCloud();
    h.state.offline = true;
    await b.signOut();
    expect(a.store.getSnapshot().namespace).toBeNull();
    expect(b.store.getSnapshot().namespace).toBeNull();
  });
  it("only minimal user and noncredential revision are ever persisted", async () => {
    const h = harness();
    const c = await h.boot();
    h.hooks["/api/auth/login"] = (_i, f) => {
      f();
      return json({
        ok: true,
        user: { ...alice, access_token: "NEVER_CACHE" },
        authRevision: h.state.revision,
        refresh_token: "NEVER_CACHE",
      });
    };
    await c.signIn("Alice", "raw-password");
    const raw = h.data.get(AUTH_LOCK_KEY)!;
    expect(raw).not.toMatch(/NEVER_CACHE|raw-password|attemptId|token/);
    expect(Object.keys(JSON.parse(raw).user).sort()).toEqual([
      "displayName",
      "id",
    ]);
  });
  it("metadata compare-and-write refuses old generations", () => {
    const h = harness();
    const lock = new AuthLock(h.storage, h.hub.endpoint());
    const a = lock.write(
      { authRevision: "A", user: alice, locked: false, pendingLogout: null },
      null,
    )!;
    const b = lock.write(
      { authRevision: "B", user: bob, locked: false, pendingLogout: null },
      a.stamp,
    )!;
    expect(
      lock.write(
        { authRevision: "A", user: null, locked: true, pendingLogout: "A" },
        a.stamp,
      ),
    ).toBeNull();
    expect(lock.read()).toEqual(b);
    lock.close();
  });
  it("late committed login persists its captured cleanup revision after initial cancel CAS was stale", async () => {
    const h = harness();
    const c = await h.boot();
    const gate = deferred<Response>();
    let response: Response | undefined;
    h.hooks["/api/auth/login"] = (_i, f) => {
      response = f();
      return gate.promise;
    };
    const pending = c.signIn("Alice", "password");
    await vi.waitFor(() => expect(response).toBeDefined());
    const committed = h.state.revision;
    c.cancelAuthentication();
    await tick();
    h.state.offline = true;
    gate.resolve(response!);
    await pending;
    expect(JSON.parse(h.data.get(AUTH_LOCK_KEY)!)).toMatchObject({
      locked: true,
      pendingLogout: committed,
      authRevision: committed,
    });
    const fresh = await h.boot();
    expect(fresh.getSnapshot().mode).toBe("login");
    h.state.offline = false;
    await fresh.sync();
    expect(h.state.user).toBeNull();
  });
  it("an invalidated old tab cannot overwrite B metadata with logout or cancel", async () => {
    const h = harness();
    const a = await h.boot();
    await a.signIn("Alice", "password");
    const b = await h.boot();
    await b.signIn("Bob", "password");
    const saved = h.data.get(AUTH_LOCK_KEY);
    await a.signOut();
    a.cancelAuthentication();
    expect(h.data.get(AUTH_LOCK_KEY)).toBe(saved);
    expect(h.state.user).toEqual(bob);
    expect(b.getSnapshot().mode).toBe("cloud");
  });
  it("normal disposal preserves verified metadata for a subsequent online restore", async () => {
    const h = harness();
    const c = await h.boot();
    await c.signIn("Alice", "password");
    const raw = h.data.get(AUTH_LOCK_KEY);
    c.dispose();
    expect(c.store.getSnapshot().namespace).toBeNull();
    expect(h.data.get(AUTH_LOCK_KEY)).toBe(raw);
    expect((await h.boot()).getSnapshot().displayName).toBe("Alice");
    await tick();
  });
});
