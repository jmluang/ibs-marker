import type { BackendUser } from "../domain/backendApi";
import { validRevision, validUser } from "./bff";
export type AuthStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const AUTH_LOCK_KEY = "ibs-marker-bff-auth-state";
export interface AuthRecord {
  stamp: string;
  authRevision: string | null;
  user: BackendUser | null;
  locked: boolean;
  pendingLogout: string | null;
}
export interface AuthEvents {
  subscribe(listener: () => void): () => void;
  publish(): void;
  close?(): void;
}
export function browserAuthStorage(): AuthStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
export function browserAuthEvents(): AuthEvents {
  const listeners = new Set<() => void>();
  let closed = false;
  const channel =
    typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(AUTH_LOCK_KEY)
      : null;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const storage = (event: StorageEvent) => {
    if (event.key === AUTH_LOCK_KEY || event.key === null) notify();
  };
  if (typeof window !== "undefined")
    window.addEventListener("storage", storage);
  if (channel) channel.onmessage = notify;
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish() {
      if (!closed) channel?.postMessage("changed");
    },
    close() {
      closed = true;
      channel?.close();
      if (typeof window !== "undefined")
        window.removeEventListener("storage", storage);
      listeners.clear();
    },
  };
}
/** Noncredential offline shell metadata, not authorization. No tokens or cookie access. */
export class AuthLock {
  durable = false;
  private memory: AuthRecord | null = null;
  readonly events: AuthEvents;
  constructor(
    private readonly storage: AuthStorage | undefined = browserAuthStorage(),
    events?: AuthEvents,
  ) {
    this.events = events ?? browserAuthEvents();
    if (storage) {
      try {
        const key = `${AUTH_LOCK_KEY}-probe-${crypto.randomUUID()}`;
        storage.setItem(key, "1");
        storage.removeItem(key);
        this.durable = true;
      } catch {
        /* No cached identity restoration when durable locking is unavailable. */
      }
    }
  }
  read(): AuthRecord | null {
    if (!this.storage) return this.memory;
    try {
      const raw = this.storage.getItem(AUTH_LOCK_KEY);
      if (raw === null) return null;
      const r = JSON.parse(raw) as AuthRecord;
      if (
        !r ||
        typeof r.stamp !== "string" ||
        typeof r.locked !== "boolean" ||
        !(r.authRevision === null || validRevision(r.authRevision)) ||
        !(r.pendingLogout === null || validRevision(r.pendingLogout)) ||
        !(r.user === null || validUser(r.user))
      )
        throw new Error("INVALID_METADATA");
      return {
        stamp: r.stamp,
        authRevision: r.authRevision,
        locked: r.locked,
        pendingLogout: r.pendingLogout,
        user: r.user
          ? { id: r.user.id, displayName: r.user.displayName }
          : null,
      };
    } catch {
      this.durable = false;
      return this.memory;
    }
  }
  /** Synchronous compare-and-write prevents old async operations overwriting new metadata. */
  write(
    value: Omit<AuthRecord, "stamp">,
    expected: string | null,
  ): AuthRecord | null {
    if ((this.read()?.stamp ?? null) !== expected) return null;
    const next = {
      ...value,
      user: value.user
        ? { id: value.user.id, displayName: value.user.displayName }
        : null,
      stamp: crypto.randomUUID(),
    };
    this.memory = next;
    try {
      this.storage?.setItem(AUTH_LOCK_KEY, JSON.stringify(next));
    } catch {
      this.durable = false;
    }
    this.events.publish();
    return next;
  }
  close() {
    this.events.close?.();
  }
}
