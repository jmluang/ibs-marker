import "fake-indexeddb/auto";
import { afterEach, vi } from "vitest";
import {
  bootstrapCloud,
  createCloudController,
  type CloudController,
  type CloudDependencies,
} from "../cloud/bootstrap";
import { TrackerStore } from "../state/TrackerStore";
import { IndexedDbAdapter } from "../storage/indexedDb";
import type { AuthEvents, AuthStorage } from "../cloud/authLock";
import type { BootstrapLocks } from "../cloud/bff";
import type { BackendUser } from "../domain/backendApi";
export const alice: BackendUser = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Alice",
};
export const bob: BackendUser = {
  id: "22222222-2222-4222-8222-222222222222",
  displayName: "Bob",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
export const tick = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
const controllers: CloudController[] = [];
const stores: TrackerStore[] = [];
afterEach(() => {
  controllers.splice(0).forEach((c) => c.dispose());
  stores.splice(0).forEach((s) => {
    s.dispose();
    s.adapter.close();
  });
  vi.restoreAllMocks();
});
export function memoryStorage() {
  const data = new Map<string, string>();
  const storage: AuthStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  return { data, storage };
}
export function sharedLocks() {
  let tail = Promise.resolve();
  const calls: string[] = [];
  const locks: BootstrapLocks = {
    request<T>(
      name: string,
      _options: { mode: "exclusive" },
      action: () => Promise<T>,
    ) {
      calls.push(name);
      const result = tail.then(action);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  return { locks, calls };
}
export function eventHub() {
  const peers = new Set<Set<() => void>>();
  return {
    endpoint(): AuthEvents {
      const listeners = new Set<() => void>();
      peers.add(listeners);
      return {
        subscribe(fn) {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
        publish() {
          for (const peer of peers)
            if (peer !== listeners) for (const fn of peer) fn();
        },
        close() {
          peers.delete(listeners);
          listeners.clear();
        },
      };
    },
  };
}
export function harness() {
  const { data, storage } = memoryStorage();
  const hub = eventHub();
  const { locks } = sharedLocks();
  const state: {
    revision: string;
    user: BackendUser | null;
    context: boolean;
    offline: boolean;
  } = { revision: "rev-0", user: null, context: true, offline: false };
  let revision = 0;
  const bump = () => (state.revision = `rev-${++revision}`);
  type Hook = (
    init: RequestInit,
    fallback: () => Response,
  ) => Response | Promise<Response>;
  const hooks: Record<string, Hook> = {};
  const fetcher = vi.fn<typeof fetch>(function (
    this: unknown,
    input,
    init = {},
  ) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    if (!String(input).startsWith("/api/"))
      throw new Error("External request prohibited");
    if (state.offline) return Promise.reject(new TypeError("offline"));
    const path = String(input).split("?")[0];
    const body = init.body
      ? (JSON.parse(String(init.body)) as Record<string, string>)
      : {};
    const fallback = (): Response => {
      if (path === "/api/auth/session")
        return state.context
          ? json({ ok: true, user: state.user, authRevision: state.revision })
          : json({ code: "SESSION_CONTEXT_REQUIRED" }, 428);
      if (path === "/api/auth/bootstrap") {
        state.context = true;
        return json({ ok: true, user: state.user, authRevision: state.revision });
      }
      if (path === "/api/auth/prepare") {
        if (body.authRevision !== state.revision)
          return json({ code: "SESSION_CHANGED" }, 409);
        state.user = null;
        bump();
        return json({
          ok: true,
          authRevision: state.revision,
          attemptId: `attempt-${revision}`,
        });
      }
      if (path === "/api/auth/login") {
        if (body.authRevision !== state.revision)
          return json({ code: "SESSION_CHANGED" }, 409);
        state.user = body.username === "Bob" ? bob : alice;
        bump();
        return json({
          ok: true,
          user: state.user,
          authRevision: state.revision,
        });
      }
      if (path === "/api/auth/logout") {
        if (body.authRevision !== state.revision)
          return json({ code: "SESSION_CHANGED" }, 409);
        state.user = null;
        bump();
        return json({ ok: true, authRevision: state.revision });
      }
      if (path === "/api/sync/pull")
        return new Headers(init.headers).get("X-Auth-Revision") ===
          state.revision
          ? json({ ok: true, rows: [] })
          : json({ code: "SESSION_CHANGED" }, 409);
      if (path === "/api/sync/push")
        return json({
          ok: true,
          result: {
            status: "applied",
            remote: { ...JSON.parse(String(init.body)).operation, version: 1 },
          },
        });
      if (path === "/api/register") return json({ ok: true }, 201);
      throw new Error(`Unknown fixture path ${path}`);
    };
    return Promise.resolve(
      hooks[path] ? hooks[path](init, fallback) : fallback(),
    );
  });
  function create(
    options: CloudDependencies & {
      env?: Record<string, unknown>;
      database?: string;
    } = {},
  ) {
    const store = new TrackerStore(
      new IndexedDbAdapter(options.database ?? crypto.randomUUID()),
    );
    stores.push(store);
    const c = createCloudController({
      store,
      env: options.env ?? {},
      fetch: fetcher,
      locks,
      authStorage: storage,
      authEvents: hub.endpoint(),
      ...options,
    });
    controllers.push(c);
    return c;
  }
  async function boot(options: Parameters<typeof create>[0] = {}) {
    const c = create(options);
    await c.initialize();
    return c;
  }
  return { data, storage, hooks, state, fetcher, boot, create, hub, locks };
}
