import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthLock, AUTH_LOCK_KEY } from "../cloud/authLock";
import { BffClient } from "../cloud/bff";
import { CloudPanel } from "../cloud/CloudPanel";
import {
  alice,
  bob,
  deferred,
  harness,
  json,
  sharedLocks,
  tick,
} from "./bff-fixture";

const unavailable = () =>
  json({ code: "AUTH_UNAVAILABLE", message: "secret" }, 503);
async function cachedAlice() {
  const h = harness();
  const database = crypto.randomUUID();
  const a = await h.boot({ database });
  await a.signIn("Alice", "password");
  await a.sync();
  h.state.offline = true;
  await a.store.saveSettings({
    ...a.store.getSnapshot().settings,
    foodTemplates: ["pending-A"],
  });
  const outbox = a.store.getSnapshot().outbox;
  a.dispose();
  h.state.offline = false;
  return { h, database, outbox };
}

describe("recoverable BFF restore and durable identity fences", () => {
  it.each(["auth503", "transport502", "network", "body-network"])(
    "cached verified A survives %s, preserving queue and reconnecting without a password",
    async (failure) => {
      const { h, database, outbox } = await cachedAlice();
      h.hooks["/api/auth/session"] = () => {
        if (failure === "network") throw new TypeError("offline");
        if (failure === "body-network") {
          const response = json({ ok: true });
          response.json = async () => {
            throw new TypeError("body connection lost");
          };
          return response;
        }
        return failure === "auth503"
          ? unavailable()
          : new Response("proxy down", { status: 502 });
      };
      const c = await h.boot({ database });
      expect(c.getSnapshot()).toMatchObject({
        mode: "cloud",
        displayName: "Alice",
        connectionRetry: true,
      });
      expect(c.store.getSnapshot().outbox).toEqual(outbox);
      expect(c.store.getSnapshot().syncStatus.state).toBe("offline");
      delete h.hooks["/api/auth/session"];
      await c.sync();
      expect(c.getSnapshot()).toMatchObject({
        mode: "cloud",
        connectionRetry: false,
      });
      expect(c.store.getSnapshot().outbox).toHaveLength(0);
      expect(
        h.fetcher.mock.calls.filter(([p]) => p === "/api/auth/login"),
      ).toHaveLength(1);
    },
  );
  it("uncached 503 shows connection retry, then restores valid server identity without a password in a single flight", async () => {
    const h = harness();
    h.state.user = alice;
    h.hooks["/api/auth/session"] = unavailable;
    const c = await h.boot();
    expect(c.getSnapshot()).toMatchObject({
      mode: "login",
      displayName: null,
      connectionRetry: true,
    });
    const markup = renderToStaticMarkup(<CloudPanel controller={c} />);
    expect(markup).toContain("重试连接");
    expect(markup).not.toContain("云端未登录");
    expect(markup).not.toContain('type="password"');
    const gate = deferred<Response>();
    let requests = 0;
    h.hooks["/api/auth/session"] = (_i, fallback) =>
      ++requests === 1 ? gate.promise : fallback();
    const retry = [c.sync(), c.sync(), c.sync()];
    await vi.waitFor(() => expect(requests).toBe(1));
    gate.resolve(
      json({ ok: true, user: alice, authRevision: h.state.revision }),
    );
    await Promise.all(retry);
    expect(requests).toBe(2); // probe + final confirmation, one transaction
    expect(c.getSnapshot()).toMatchObject({
      mode: "cloud",
      displayName: "Alice",
      connectionRetry: false,
    });
    expect(h.fetcher.mock.calls.some(([p]) => p === "/api/auth/login")).toBe(
      false,
    );
  });
  it.each([
    [401, "UNAUTHENTICATED"],
    [409, "SESSION_CHANGED"],
    [403, "unknown-secret"],
  ] as const)(
    "restore %s durably invalidates cached A before persistence, including fresh offline/503 controllers",
    async (status, code) => {
      const { h, database, outbox } = await cachedAlice();
      h.hooks["/api/auth/session"] = () => json({ code }, status);
      const c = h.create({ database });
      const setItem = h.storage.setItem.bind(h.storage);
      const writes: string[] = [];
      vi.spyOn(h.storage, "setItem").mockImplementation((key, value) => {
        if (key === AUTH_LOCK_KEY) {
          expect(c.store.getSnapshot().namespace).toBeNull();
          expect(c.getSnapshot().displayName).toBeNull();
          writes.push(value);
        }
        setItem(key, value);
      });
      await c.initialize();
      expect(c.getSnapshot()).toMatchObject({
        mode: "login",
        connectionRetry: false,
      });
      expect(writes).toHaveLength(1);
      expect(c.authLock.read()).toMatchObject({
        locked: true,
        user: alice,
        pendingLogout: null,
      });
      c.dispose();
      h.hooks["/api/auth/session"] = unavailable;
      expect(
        (await h.boot({ database })).store.getSnapshot().namespace,
      ).toBeNull();
      h.state.offline = true;
      const offline = await h.boot({ database });
      expect(offline.store.getSnapshot().namespace).toBeNull();
      expect(
        (await offline.store.adapter.read(`user:${alice.id}`)).outbox,
      ).toEqual(outbox);
      expect(h.fetcher.mock.calls.some(([p]) => p === "/api/auth/logout")).toBe(
        false,
      );
    },
  );
  it.each([
    "probe-null",
    "probe-B",
    "probe-revision",
    "bootstrap-null",
    "bootstrap-B",
    "bootstrap-revision",
  ])(
    "%s observation before later 503 fences A durably, without writing unconfirmed B",
    async (scenario) => {
      const { h, database, outbox } = await cachedAlice();
      const originalRevision = h.state.revision;
      const observed = {
        ok: true,
        user: scenario.endsWith("null")
          ? null
          : scenario.endsWith("B")
            ? bob
            : alice,
        authRevision: "new-revision",
      };
      let calls = 0;
      h.hooks["/api/auth/session"] = (_i, fallback) => {
        calls++;
        if (scenario.startsWith("probe"))
          return calls === 1 ? json(observed) : unavailable();
        return calls === 1 ? fallback() : unavailable();
      };
      h.hooks["/api/auth/bootstrap"] = () =>
        scenario.startsWith("probe") ? unavailable() : json(observed);
      const c = await h.boot({ database });
      expect(c.store.getSnapshot().namespace).toBeNull();
      expect(c.authLock.read()).toMatchObject({
        locked: true,
        user: alice,
        authRevision: originalRevision,
        pendingLogout: null,
      });
      c.dispose();
      h.state.offline = true;
      const offline = await h.boot({ database });
      expect(offline.store.getSnapshot().namespace).toBeNull();
      expect(
        (await offline.store.adapter.read(`user:${alice.id}`)).outbox,
      ).toEqual(outbox);
      expect(h.fetcher.mock.calls.some(([p]) => p === "/api/auth/logout")).toBe(
        false,
      );
    },
  );
  it("a fully confirmed replacement may be accepted using only restore's own fence stamp", async () => {
    const { h, database } = await cachedAlice();
    h.state.user = bob;
    h.state.revision = "server-B";
    const c = await h.boot({ database });
    expect(c.getSnapshot()).toMatchObject({
      mode: "cloud",
      displayName: "Bob",
    });
    expect(c.authLock.read()).toMatchObject({
      locked: false,
      user: bob,
      authRevision: "server-B",
    });
  });
  it.each(["401", "observation"])(
    "late %s from A cannot lock, overwrite or logout externally published B",
    async (scenario) => {
      const { h, database } = await cachedAlice();
      const gate = deferred<Response>();
      let started = false;
      h.hooks["/api/auth/session"] = () => {
        started = true;
        return gate.promise;
      };
      const c = h.create({
        database,
        authEvents: { subscribe: () => () => {}, publish: () => {} },
      });
      const init = c.initialize();
      await vi.waitFor(() => expect(started).toBe(true));
      const peer = new AuthLock(h.storage, h.hub.endpoint());
      peer.write(
        {
          user: bob,
          authRevision: "external-B",
          locked: false,
          pendingLogout: null,
        },
        peer.read()!.stamp,
      );
      const metadata = h.data.get(AUTH_LOCK_KEY);
      h.hooks["/api/auth/bootstrap"] = unavailable;
      gate.resolve(
        scenario === "401"
          ? json({ code: "UNAUTHENTICATED" }, 401)
          : json({ ok: true, user: null, authRevision: "null-rev" }),
      );
      await init;
      expect(h.data.get(AUTH_LOCK_KEY)).toBe(metadata);
      expect(c.store.getSnapshot().namespace).toBeNull();
      expect(h.fetcher.mock.calls.some(([p]) => p === "/api/auth/logout")).toBe(
        false,
      );
      peer.close();
    },
  );
  it.each([null, "old-A"])(
    "entry lock (pending=%s) survives successful restore and transient failures until fresh sign-in",
    async (pendingLogout) => {
      const h = harness();
      const lock = new AuthLock(h.storage, h.hub.endpoint());
      lock.write(
        { user: alice, authRevision: "old-A", locked: true, pendingLogout },
        null,
      );
      h.state.user = bob;
      h.state.revision = "server-B";
      const c = await h.boot();
      expect(c.getSnapshot().mode).toBe("login");
      expect(c.authLock.read()?.locked).toBe(true);
      h.hooks["/api/auth/session"] = unavailable;
      const fresh = await h.boot();
      expect(fresh.getSnapshot()).toMatchObject({
        mode: "login",
        connectionRetry: false,
      });
      expect(fresh.store.getSnapshot().namespace).toBeNull();
      delete h.hooks["/api/auth/session"];
      expect(await fresh.signIn("Bob", "password")).toBe(true);
      expect(fresh.authLock.read()?.locked).toBe(false);
      lock.close();
    },
  );
  it("wrong password does not arm foreground automatic restore", async () => {
    const h = harness();
    h.hooks["/api/auth/session"] = unavailable;
    const c = await h.boot();
    delete h.hooks["/api/auth/session"];
    h.hooks["/api/auth/login"] = () =>
      json({ code: "INVALID_CREDENTIALS" }, 401);
    await c.signIn("Alice", "wrong-password");
    h.fetcher.mockClear();
    await c.sync();
    expect(c.getSnapshot()).toMatchObject({
      mode: "login",
      connectionRetry: false,
    });
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [403, "FORBIDDEN", "cloud"],
    [403, "INVALID_REQUEST", "cloud"],
    [403, "unknown-secret", "login"],
    [401, "FORBIDDEN", "login"],
    [401, "23505", "login"],
    [403, "23505", "login"],
    [409, "SESSION_CHANGED", "login"],
  ] as const)(
    "sync %s/%s yields %s without dropping queue",
    async (status, code, mode) => {
      const { h, database, outbox } = await cachedAlice();
      h.hooks["/api/sync/pull"] = () => json({ code }, status);
      const c = await h.boot({ database });
      await c.sync();
      expect(c.getSnapshot().mode).toBe(mode);
      expect(c.authLock.read()?.locked).toBe(mode === "login");
      expect((await c.store.adapter.read(`user:${alice.id}`)).outbox).toEqual(
        outbox,
      );
      if (mode === "cloud")
        expect(c.store.getSnapshot().syncStatus.state).toBe("error");
    },
  );
});

describe("restore concurrency and transport fail-closed details", () => {
  it("online and foreground signals join one recoverable restore flight", async () => {
    const windowEvents = new EventTarget();
    const documentEvents = Object.assign(new EventTarget(), {
      visibilityState: "visible",
    });
    vi.stubGlobal("window", windowEvents);
    vi.stubGlobal("document", documentEvents);
    const h = harness();
    let c: Awaited<ReturnType<typeof h.boot>> | undefined;
    try {
      h.state.user = alice;
      h.hooks["/api/auth/session"] = unavailable;
      c = await h.boot();
      const gate = deferred<Response>();
      let requests = 0;
      h.hooks["/api/auth/session"] = (_i, fallback) =>
        ++requests === 1 ? gate.promise : fallback();
      windowEvents.dispatchEvent(new Event("online"));
      documentEvents.dispatchEvent(new Event("visibilitychange"));
      windowEvents.dispatchEvent(new Event("online"));
      await vi.waitFor(() => expect(requests).toBe(1));
      gate.resolve(
        json({ ok: true, user: alice, authRevision: h.state.revision }),
      );
      await vi.waitFor(() => expect(c!.getSnapshot().mode).toBe("cloud"));
      expect(requests).toBe(2);
      expect(c.getSnapshot().connectionRetry).toBe(false);
    } finally {
      c?.dispose();
      vi.unstubAllGlobals();
    }
  });
  it.each(["cancel", "dispose"] as const)(
    "%s epoch-fences late restore observations without overwriting the user lock",
    async (action) => {
      const { h, database } = await cachedAlice();
      const gate = deferred<Response>();
      let started = false;
      h.hooks["/api/auth/session"] = () => {
        started = true;
        return gate.promise;
      };
      const c = h.create({ database });
      const pending = c.initialize();
      await vi.waitFor(() => expect(started).toBe(true));
      action === "cancel" ? c.cancelAuthentication() : c.dispose();
      const metadata = h.data.get(AUTH_LOCK_KEY);
      h.hooks["/api/auth/bootstrap"] = unavailable;
      gate.resolve(json({ ok: true, user: bob, authRevision: "late-B" }));
      await pending;
      expect(h.data.get(AUTH_LOCK_KEY)).toBe(metadata);
      expect(c.store.getSnapshot().namespace).toBeNull();
    },
  );
  it("restore definitive failure CAS-locks the current same-identity metadata refresh", async () => {
    const { h, database } = await cachedAlice();
    const gate = deferred<Response>();
    let started = false;
    h.hooks["/api/auth/session"] = () => {
      started = true;
      return gate.promise;
    };
    const c = h.create({
      database,
      authEvents: { subscribe: () => () => {}, publish: () => {} },
    });
    const pending = c.initialize();
    await vi.waitFor(() => expect(started).toBe(true));
    const peer = new AuthLock(h.storage, h.hub.endpoint());
    const current = peer.read()!;
    peer.write(
      { ...current, user: { ...alice, displayName: "Updated Alice" } },
      current.stamp,
    );
    gate.resolve(json({ code: "SESSION_CHANGED" }, 409));
    await pending;
    expect(c.authLock.read()).toMatchObject({
      locked: true,
      user: { ...alice, displayName: "Updated Alice" },
    });
    peer.close();
  });
  it("metadata published while IndexedDB opens prevents stale offline A even without events", async () => {
    const { h, database } = await cachedAlice();
    h.state.offline = true;
    const c = h.create({
      database,
      authEvents: { subscribe: () => () => {}, publish: () => {} },
    });
    const gate = deferred<void>();
    const read = c.store.adapter.read.bind(c.store.adapter);
    let opening = false;
    vi.spyOn(c.store.adapter, "read").mockImplementation(async (namespace) => {
      if (namespace === `user:${alice.id}`) {
        opening = true;
        await gate.promise;
      }
      return read(namespace);
    });
    const pending = c.initialize();
    await vi.waitFor(() => expect(opening).toBe(true));
    const peer = new AuthLock(h.storage, h.hub.endpoint());
    peer.write(
      {
        user: bob,
        authRevision: "external-B",
        locked: false,
        pendingLogout: null,
      },
      peer.read()!.stamp,
    );
    const metadata = h.data.get(AUTH_LOCK_KEY);
    gate.resolve();
    await pending;
    expect(c.store.getSnapshot().namespace).toBeNull();
    expect(c.getSnapshot().displayName).toBeNull();
    expect(h.data.get(AUTH_LOCK_KEY)).toBe(metadata);
    peer.close();
  });
  it.each(["definitive", "observation"])(
    "%s lock write failure remains quarantined and reports durable failure",
    async (scenario) => {
      const { h, database } = await cachedAlice();
      h.hooks["/api/auth/session"] = () =>
        scenario === "definitive"
          ? json({ code: "UNAUTHENTICATED" }, 401)
          : json({ ok: true, user: bob, authRevision: "observed-B" });
      h.hooks["/api/auth/bootstrap"] = unavailable;
      const c = h.create({ database });
      vi.spyOn(h.storage, "setItem").mockImplementation(() => {
        expect(c.store.getSnapshot().namespace).toBeNull();
        expect(c.getSnapshot().displayName).toBeNull();
        throw new Error("private-storage-error");
      });
      await c.initialize();
      expect(c.getSnapshot().error).toMatch(/持久化.*锁定失败/);
      expect(c.getSnapshot().error).not.toContain("private-storage-error");
      expect(c.authLock.durable).toBe(false);
      expect(c.store.getSnapshot().namespace).toBeNull();
    },
  );
  it("an external B published after an owned observation fence wins over late complete confirmation", async () => {
    const { h, database } = await cachedAlice();
    const gate = deferred<Response>();
    let probes = 0;
    const observed = { ok: true, user: null, authRevision: "observed-null" };
    h.hooks["/api/auth/session"] = () =>
      ++probes === 1 ? json(observed) : gate.promise;
    h.hooks["/api/auth/bootstrap"] = () => json(observed);
    const c = h.create({
      database,
      authEvents: { subscribe: () => () => {}, publish: () => {} },
    });
    const pending = c.initialize();
    await vi.waitFor(() => expect(probes).toBe(2));
    expect(c.authLock.read()?.locked).toBe(true);
    const peer = new AuthLock(h.storage, h.hub.endpoint());
    peer.write(
      {
        user: bob,
        authRevision: "external-B",
        locked: false,
        pendingLogout: null,
      },
      peer.read()!.stamp,
    );
    const metadata = h.data.get(AUTH_LOCK_KEY);
    gate.resolve(
      json({ ok: true, user: alice, authRevision: h.state.revision }),
    );
    await pending;
    expect(h.data.get(AUTH_LOCK_KEY)).toBe(metadata);
    expect(c.store.getSnapshot().namespace).toBeNull();
    expect(h.fetcher.mock.calls.some(([p]) => p === "/api/auth/logout")).toBe(
      false,
    );
    peer.close();
  });
  it.each(["bad-json", "body401", "unallowlisted503"])(
    "%s never permits the old cached offline identity",
    async (scenario) => {
      const { h, database } = await cachedAlice();
      h.hooks["/api/auth/session"] = () => {
        if (scenario === "bad-json") return new Response("broken JSON");
        if (scenario === "unallowlisted503")
          return json({ code: "INVALID_CREDENTIALS" }, 503);
        const response = json({}, 401);
        response.json = async () => {
          throw new TypeError("truncated body");
        };
        return response;
      };
      const c = await h.boot({ database });
      expect(c.store.getSnapshot().namespace).toBeNull();
      expect(c.getSnapshot().connectionRetry).toBe(false);
      if (scenario === "body401") expect(c.authLock.read()?.locked).toBe(true);
    },
  );
});

describe("persistent cookie handshake", () => {
  it("reports distinct observations in stage order and returns only final confirmation", async () => {
    const h = harness();
    const probe = { ok: true, user: alice, authRevision: "probe-A" };
    const bootstrap = { ok: true, user: null, authRevision: "bootstrap-null" };
    const confirm = { ok: true, user: bob, authRevision: "confirm-B" };
    let calls = 0;
    h.hooks["/api/auth/session"] = () => json(++calls === 1 ? probe : confirm);
    h.hooks["/api/auth/bootstrap"] = () => json(bootstrap);
    const observations: unknown[] = [];
    expect(
      await new BffClient(h.fetcher, h.locks).session({
        onObserved: (s) => observations.push(s),
      }),
    ).toEqual(confirm);
    expect(observations).toEqual([probe, bootstrap, confirm]);
  });
  it("without Web Locks, existing context is observed but never unsafely reissues a cookie", async () => {
    const h = harness();
    h.state.user = alice;
    const onObserved = vi.fn();
    const result = await new BffClient(h.fetcher, null).session({ onObserved });
    expect(onObserved).toHaveBeenCalledExactlyOnceWith(result);
    expect(h.fetcher.mock.calls.map(([p]) => p)).toEqual(["/api/auth/session"]);
  });
  it("healthy context still bootstraps, observes every fully consumed session, and returns final confirmation", async () => {
    const h = harness();
    h.state.user = alice;
    const observed: unknown[] = [];
    const session = await new BffClient(h.fetcher, h.locks).session({
      onObserved: (s) => observed.push(s),
    });
    expect(h.fetcher.mock.calls.map(([p]) => p)).toEqual([
      "/api/auth/session",
      "/api/auth/bootstrap",
      "/api/auth/session",
    ]);
    expect(observed).toEqual([session, session, session]);
    expect(JSON.parse(String(h.fetcher.mock.calls[1][1]?.body))).toEqual({});
  });
  it("healthy cookie transaction retains the lock through bootstrap and confirm bodies even after cancel", async () => {
    const h = harness();
    const { locks } = sharedLocks();
    const bootstrapBody = deferred<unknown>();
    const confirmBody = deferred<unknown>();
    let bootstrapCount = 0;
    let probes = 0;
    h.hooks["/api/auth/bootstrap"] = (_i, fallback) => {
      bootstrapCount++;
      const response = fallback();
      if (bootstrapCount === 1) response.json = () => bootstrapBody.promise;
      return response;
    };
    h.hooks["/api/auth/session"] = (_i, fallback) => {
      const response = fallback();
      if (++probes === 2) response.json = () => confirmBody.promise;
      return response;
    };
    const a = h.create({ locks });
    const first = a.initialize();
    await vi.waitFor(() => expect(bootstrapCount).toBe(1));
    a.cancelAuthentication();
    const second = new BffClient(h.fetcher, locks).session();
    await tick();
    expect(probes).toBe(1);
    bootstrapBody.resolve({
      ok: true,
      user: null,
      authRevision: h.state.revision,
    });
    await vi.waitFor(() => expect(probes).toBe(2));
    await tick();
    expect(bootstrapCount).toBe(1);
    confirmBody.resolve({
      ok: true,
      user: null,
      authRevision: h.state.revision,
    });
    await Promise.all([first, second]);
    expect(bootstrapCount).toBe(2);
    expect(a.store.getSnapshot().namespace).toBeNull();
  });
});
