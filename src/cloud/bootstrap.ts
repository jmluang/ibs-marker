import { isValidUsername } from "../domain/username";
import {
  isRegistrationErrorCode,
  type RegistrationResult,
} from "../domain/authErrors";
import type { BackendSession } from "../domain/backendApi";
import { registrationError, type AuthErrorField } from "./authMessages";
import { trackerStore, type TrackerStore } from "../state/TrackerStore";
import { readCloudConfig, type CloudConfig } from "./config";
import { SyncEngine } from "./engine";
import { BffTransport } from "./transport";
import {
  BffClient,
  BffError,
  loginError,
  parseSession,
  validRevision,
  type BootstrapLocks,
} from "./bff";
import {
  AuthLock,
  type AuthRecord,
  type AuthStorage,
  type AuthEvents,
} from "./authLock";
const persistenceCleanupError =
  "本页已锁定；退出状态持久化清理失败，请重试，勿直接关闭共享设备。";
const connectionError = "暂时无法连接账号服务，请重试连接；无需重新输入密码。";
function recoverableConnection(error: unknown) {
  return (
    error instanceof TypeError ||
    (error instanceof BffError &&
      ((error.status === 503 && error.code === "AUTH_UNAVAILABLE") ||
        (error.status >= 500 &&
          error.status <= 599 &&
          error.code === "REQUEST_FAILED")))
  );
}
function invalidSession(error: unknown) {
  return (
    error instanceof BffError &&
    (error.status === 401 ||
      (error.status === 409 && error.code === "SESSION_CHANGED") ||
      (error.status === 403 &&
        !["FORBIDDEN", "INVALID_REQUEST"].includes(error.code)))
  );
}
export interface CloudState {
  configuration: CloudConfig["state"];
  mode: "checking" | "login" | "cloud" | "local";
  displayName: string | null;
  privateMode: boolean;
  error: string | null;
  errorField?: AuthErrorField;
  busy: boolean;
  connectionRetry: boolean;
}
export interface CloudDependencies {
  fetch?: typeof fetch;
  registerFetch?: typeof fetch;
  locks?: BootstrapLocks | null;
  authStorage?: AuthStorage;
  authEvents?: AuthEvents;
}
interface Attempt {
  epoch: number;
  revision: string | null;
  stamp: string | null;
  cancelled: boolean;
}
export class CloudController {
  private state: CloudState;
  private listeners = new Set<() => void>();
  private engine: SyncEngine | null = null;
  private epoch = 0;
  private disposed = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private lastQueue = "";
  private offStore: (() => void) | null = null;
  private offAuth: (() => void) | null = null;
  private registrationAbort: AbortController | null = null;
  private attempt: Attempt | null = null;
  private revision: string | null = null;
  private observedStamp: string | null = null;
  private restoreFlight: { epoch: number; promise: Promise<void> } | null =
    null;
  readonly client: BffClient;
  readonly authLock: AuthLock;
  private readonly registerFetch: typeof fetch;
  constructor(
    readonly store: TrackerStore,
    readonly config: CloudConfig,
    dependencies: CloudDependencies = {},
  ) {
    this.client = new BffClient(dependencies.fetch, dependencies.locks);
    this.authLock = new AuthLock(
      dependencies.authStorage,
      dependencies.authEvents,
    );
    this.registerFetch = dependencies.registerFetch ?? this.client.fetcher;
    this.state = {
      configuration: config.state,
      mode: "checking",
      displayName: null,
      privateMode: config.state !== "absent",
      error: config.state === "invalid" ? config.message : null,
      busy: false,
      connectionRetry: false,
    };
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private update(p: Partial<CloudState>) {
    if ("error" in p && !("errorField" in p)) p.errorField = undefined;
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn();
  }
  private current(epoch: number) {
    return !this.disposed && epoch === this.epoch;
  }
  private stop() {
    this.epoch++;
    this.registrationAbort?.abort();
    this.registrationAbort = null;
    if (this.attempt) this.attempt.cancelled = true;
    this.engine?.cancel();
    this.engine = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.lastQueue = "";
  }
  private invalidate(message: string | null = null) {
    this.stop();
    void this.store.activate(null);
    this.update({
      mode: "login",
      displayName: null,
      busy: false,
      error: message,
      connectionRetry: false,
    });
  }
  private write(value: Omit<AuthRecord, "stamp">, expected: string | null) {
    const result = this.authLock.write(value, expected);
    if (result) this.observedStamp = result.stamp;
    return result;
  }
  private external = () => {
    const record = this.authLock.read();
    if ((record?.stamp ?? null) === this.observedStamp) return;
    this.observedStamp = record?.stamp ?? null;
    // Metadata refreshes for the identical verified generation are not account
    // changes. Real revision/identity changes and every logout lock still fence.
    if (
      record &&
      !record.locked &&
      record.authRevision === this.revision &&
      record.user &&
      this.store.getSnapshot().namespace === `user:${record.user.id}` &&
      !this.attempt
    )
      return;
    this.revision = null;
    this.invalidate("账号状态已在其他标签页变更，请重新确认登录。");
  };
  private async accept(
    session: BackendSession,
    epoch: number,
    startSync = true,
  ) {
    if (!session.user || !this.current(epoch)) return false;
    this.revision = session.authRevision;
    this.update({ mode: "checking", displayName: null, error: null });
    try {
      await this.store.activate(`user:${session.user.id}`);
    } catch {
      if (this.current(epoch)) {
        void this.store.activate(null);
        this.update({
          mode: "login",
          displayName: null,
          busy: false,
          error: "无法打开账号离线存储，请重试。",
        });
      }
      return false;
    }
    if (!this.current(epoch)) return false;
    // Storage events can be delayed or absent. Recheck ownership after opening
    // IndexedDB so an in-flight restore cannot expose A after B was published.
    const owner = this.authLock.read();
    if (
      !owner ||
      owner.locked ||
      owner.pendingLogout ||
      owner.authRevision !== session.authRevision ||
      owner.user?.id !== session.user.id
    ) {
      this.external();
      return false;
    }
    const engine = new SyncEngine(
      this.store,
      new BffTransport(session.authRevision, this.client.fetcher),
    );
    this.engine?.cancel();
    this.engine = engine;
    const authRevision = session.authRevision;
    const userId = session.user.id;
    engine.onAuthFailure = () => {
      if (this.engine !== engine) return;
      // Fence visible identity before fallible persistence. Never log out a newer
      // server generation or replace another tab's identity/logout marker.
      this.invalidate("云会话失效或权限被拒绝，请重新登录。");
      this.revision = null;
      const record = this.authLock.read();
      if (
        record &&
        !record.locked &&
        record.authRevision === authRevision &&
        record.user?.id === userId
      ) {
        // Same-generation metadata may have refreshed since accept(): CAS the
        // current matching stamp, not the original accepted stamp.
        this.write({ ...record, locked: true }, record.stamp);
      }
      if (!this.authLock.durable)
        this.update({
          error:
            "本页已锁定；会话失效状态持久化锁定失败，请重试，勿直接关闭共享设备。",
        });
    };
    this.update({
      mode: "cloud",
      displayName: session.user.displayName,
      busy: false,
      error: null,
    });
    if (startSync) void engine.sync();
    return true;
  }
  async initialize() {
    const epoch = this.epoch;
    await this.store.activate(null);
    if (!this.current(epoch)) return this;
    if (this.config.state === "absent") {
      await this.store.activate("local");
      if (this.current(epoch)) this.update({ mode: "local" });
      return this;
    }
    if (this.config.state !== "ready") {
      this.update({ mode: "login" });
      return this;
    }
    this.observedStamp = this.authLock.read()?.stamp ?? null;
    this.offAuth = this.authLock.events.subscribe(this.external);
    this.offStore = this.store.subscribe(() => {
      if (this.state.mode !== "cloud") return;
      const snap = this.store.getSnapshot();
      const key = snap.outbox.map((o) => o.changeId).join(",");
      if (key === this.lastQueue) return;
      this.lastQueue = key;
      if (this.debounce) clearTimeout(this.debounce);
      if (
        snap.outbox.some(
          (o) => !snap.conflicts.some((c) => c.resourceId === o.resourceId),
        )
      )
        this.debounce = setTimeout(() => {
          void this.sync();
        }, 600);
    });
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.foreground);
      document.addEventListener("visibilitychange", this.foreground);
    }
    await this.startRestore(epoch);
    return this;
  }
  /** Lock only the captured identity, CASing its current matching metadata stamp. */
  private fenceCached(cached: AuthRecord | null) {
    if (!cached?.user || !cached.authRevision) return null;
    const record = this.authLock.read();
    if (
      !record ||
      record.locked ||
      record.pendingLogout ||
      record.authRevision !== cached.authRevision ||
      record.user?.id !== cached.user.id
    )
      return null;
    const saved = this.write({ ...record, locked: true }, record.stamp);
    if (!this.authLock.durable)
      this.update({
        error:
          "本页已锁定；会话失效状态持久化锁定失败，请重试，勿直接关闭共享设备。",
      });
    return saved;
  }
  private startRestore(epoch: number): Promise<void> {
    if (this.restoreFlight?.epoch === epoch) return this.restoreFlight.promise;
    const promise = this.restore(epoch).finally(() => {
      if (this.restoreFlight?.promise === promise) this.restoreFlight = null;
    });
    this.restoreFlight = { epoch, promise };
    return promise;
  }
  private async restore(epoch: number) {
    const cached = this.authLock.read();
    // Entry locks are explicit user intent. Observation-created fences below may
    // be replaced only by this transaction's fully confirmed final identity.
    const entryLocked = !!(cached?.locked || cached?.pendingLogout);
    let expected = cached?.stamp ?? null;
    let contradicted = false;
    let fencePersistenceFailed = false;
    const isolate = () => {
      this.engine?.cancel();
      this.engine = null;
      this.revision = null;
      void this.store.activate(null);
      this.update({
        mode: "login",
        displayName: null,
        busy: false,
        connectionRetry: false,
      });
    };
    try {
      const session = await this.client.session({
        onObserved: (observed) => {
          if (
            !this.current(epoch) ||
            entryLocked ||
            contradicted ||
            !cached?.user
          )
            return;
          if (
            observed.user?.id === cached.user.id &&
            observed.authRevision === cached.authRevision
          )
            return;
          contradicted = true;
          // Quarantine visible A before fallible persistence, but keep this
          // transaction's epoch alive to accept its final verified identity.
          isolate();
          const locked = this.fenceCached(cached);
          if (locked) expected = locked.stamp;
          fencePersistenceFailed = !!locked && !this.authLock.durable;
        },
      });
      if (!this.current(epoch)) return;
      this.revision = session.authRevision;
      if (entryLocked) {
        if (cached?.pendingLogout) await this.retryLogout(cached, epoch);
        if (this.current(epoch))
          this.update({
            mode: "login",
            displayName: null,
            busy: false,
            connectionRetry: false,
          });
        return;
      }
      const saved = this.write(
        {
          authRevision: session.authRevision,
          user: session.user,
          locked: false,
          pendingLogout: null,
        },
        expected,
      );
      if (!saved) {
        this.external();
        return;
      }
      this.update({ connectionRetry: false });
      if (session.user) await this.accept(session, epoch);
      else this.update({ mode: "login", displayName: null, busy: false });
    } catch (error) {
      if (!this.current(epoch)) return;
      if (invalidSession(error)) {
        this.invalidate("云会话已失效，请重新登录。");
        this.revision = null;
        this.fenceCached(cached);
        return;
      }
      const recoverable = recoverableConnection(error);
      const record = this.authLock.read();
      if (
        recoverable &&
        !entryLocked &&
        !contradicted &&
        this.authLock.durable &&
        cached?.user &&
        cached.authRevision &&
        !cached.locked &&
        !cached.pendingLogout &&
        record?.stamp === cached.stamp &&
        !record.locked &&
        !record.pendingLogout &&
        record.user?.id === cached.user.id &&
        record.authRevision === cached.authRevision
      ) {
        const opened = await this.accept(
          { ok: true, user: cached.user, authRevision: cached.authRevision },
          epoch,
          false,
        );
        if (opened && this.current(epoch)) {
          this.store.setSyncStatus(this.store.identityToken(), {
            state: "offline",
            message: "连接暂不可用，账号离线副本与待同步队列已保留。",
          });
          this.update({ connectionRetry: true, error: null });
        }
      } else {
        isolate();
        this.update({
          connectionRetry: recoverable && !entryLocked && !contradicted,
          error: fencePersistenceFailed
            ? "本页已锁定；会话失效状态持久化锁定失败，请重试，勿直接关闭共享设备。"
            : entryLocked &&
                !(
                  error instanceof BffError &&
                  error.code === "BOOTSTRAP_UNSUPPORTED"
                )
              ? null
              : contradicted
                ? "账号会话已变更，请重新登录。"
                : recoverable
                  ? connectionError
                  : loginError(error),
        });
      }
    }
  }
  async retryConnection() {
    if (
      this.disposed ||
      !this.state.connectionRetry ||
      this.config.state !== "ready"
    )
      return;
    await this.startRestore(this.epoch);
  }
  private foreground = () => {
    if (
      typeof document === "undefined" ||
      document.visibilityState === "visible"
    )
      void this.sync();
  };
  async sync() {
    if (this.state.connectionRetry) {
      await this.retryConnection();
      if (this.state.connectionRetry) return;
    }
    if (this.engine) {
      await this.engine.sync();
      return;
    }
    const record = this.authLock.read();
    if (record?.locked && record.pendingLogout)
      await this.retryLogout(record, this.epoch);
  }
  private async retryLogout(
    record: AuthRecord,
    epoch: number,
    owner: Attempt | null = null,
  ) {
    const revision = record.pendingLogout;
    if (!revision) return;
    try {
      const result = (await this.client.request("/api/auth/logout", {
        method: "POST",
        body: { authRevision: revision },
      })) as { authRevision: string };
      if (!validRevision(result.authRevision))
        throw new BffError("INVALID_RESPONSE");
      const saved = this.write(
        {
          authRevision: result.authRevision,
          user: null,
          locked: true,
          pendingLogout: null,
        },
        record.stamp,
      );
      if (owner && saved && owner.stamp === record.stamp)
        owner.stamp = saved.stamp;
      if (this.current(epoch) && saved) {
        this.revision = result.authRevision;
        if (this.authLock.durable) this.update({ error: null });
      }
    } catch (error) {
      if (error instanceof BffError && error.code === "SESSION_CHANGED") {
        // Never upgrade an old logout to the current server identity's revision.
        const saved = this.write(
          { ...record, pendingLogout: null },
          record.stamp,
        );
        if (owner && saved && owner.stamp === record.stamp)
          owner.stamp = saved.stamp;
      } else if (this.current(epoch) && this.authLock.durable)
        this.update({ error: "本页已锁定；网络恢复后将重试退出。" });
    }
  }
  private async cleanupAttempt(revision: string, attempt: Attempt) {
    const current = this.authLock.read();
    let locked: AuthRecord | null = null;
    if ((current?.stamp ?? null) === attempt.stamp) {
      locked = this.write(
        {
          authRevision: revision,
          user: null,
          locked: true,
          pendingLogout: revision,
        },
        attempt.stamp,
      );
      if (locked) attempt.stamp = locked.stamp;
    }
    // Even if B now owns metadata, CAS against A is safe; never mutate B's cache.
    if (locked) await this.retryLogout(locked, -1);
    else {
      try {
        await this.client.request("/api/auth/logout", {
          method: "POST",
          body: { authRevision: revision },
        });
      } catch {
        /* Old revision cannot invalidate newer B. */
      }
    }
  }
  async signIn(
    username: string,
    password: string,
  ): Promise<boolean | undefined> {
    if (this.disposed || this.config.state !== "ready") return false;
    if (!isValidUsername(username)) {
      this.update({
        error: "请输入有效用户名。",
        errorField: "username",
        busy: false,
        connectionRetry: false,
      });
      return false;
    }
    this.invalidate();
    const epoch = this.epoch;
    const before = this.authLock.read();
    // Claim local metadata synchronously. A late logout/cleanup from the previous
    // attempt must not change its stamp while this attempt awaits GET/prepare.
    const claim = this.write(
      {
        authRevision: this.revision,
        user: null,
        locked: true,
        pendingLogout: null,
      },
      before?.stamp ?? null,
    );
    if (!claim) {
      this.external();
      return;
    }
    const attempt: Attempt = {
      epoch,
      revision: this.revision,
      stamp: claim.stamp,
      cancelled: false,
    };
    this.attempt = attempt;
    this.update({ busy: true, error: null });
    try {
      const session = await this.client.session();
      if (!this.current(epoch)) return;
      attempt.revision = session.authRevision;
      this.revision = session.authRevision;
      // Stateful calls retain their response bodies after UI cancellation so a
      // late committed generation can be fenced with a revision-bound logout.
      const prepared = await this.client.prepare(
        session.authRevision,
        new AbortController().signal,
      );
      attempt.revision = prepared.authRevision;
      if (!this.current(epoch)) {
        await this.cleanupAttempt(prepared.authRevision, attempt);
        return;
      }
      const record = this.write(
        {
          authRevision: prepared.authRevision,
          user: null,
          locked: true,
          pendingLogout: null,
        },
        attempt.stamp,
      );
      if (!record) {
        await this.cleanupAttempt(prepared.authRevision, attempt);
        this.external();
        return;
      }
      attempt.stamp = record.stamp;
      this.revision = prepared.authRevision;
      const loggedIn = parseSession(
        await this.client.request("/api/auth/login", {
          method: "POST",
          body: {
            username,
            password,
            attemptId: prepared.attemptId,
            authRevision: prepared.authRevision,
          },
        }),
      );
      if (!this.current(epoch)) {
        await this.cleanupAttempt(loggedIn.authRevision, attempt);
        return;
      }
      if (!loggedIn.user) throw new BffError("INVALID_RESPONSE");
      const accepted = this.write(
        {
          authRevision: loggedIn.authRevision,
          user: loggedIn.user,
          locked: false,
          pendingLogout: null,
        },
        attempt.stamp,
      );
      if (!accepted) {
        await this.cleanupAttempt(loggedIn.authRevision, attempt);
        this.external();
        return;
      }
      this.attempt = null;
      const opened = await this.accept(loggedIn, epoch);
      return this.current(epoch) ? opened : undefined;
    } catch (error) {
      if (!this.current(epoch)) return;
      this.attempt = null;
      this.update({ mode: "login", error: loginError(error), busy: false });
      return false;
    }
  }
  private lockAuthentication() {
    const attempt = this.attempt;
    const revision = attempt?.revision ?? this.revision;
    const expected = attempt?.stamp ?? this.observedStamp;
    // Always clear UI and namespace before fallible persistence/network work.
    this.invalidate();
    this.attempt = null;
    const current = this.authLock.read();
    // An externally invalidated tab has no revision ownership. It may lock its
    // own UI, but cannot overwrite the newer tab's metadata or logout marker.
    const record =
      current && current.authRevision !== revision
        ? null
        : this.write(
            {
              authRevision: revision,
              user: null,
              locked: true,
              pendingLogout: revision,
            },
            expected,
          );
    if (attempt && record) attempt.stamp = record.stamp;
    if (!this.authLock.durable) this.update({ error: persistenceCleanupError });
    return { record, attempt };
  }
  cancelAuthentication() {
    if (this.disposed || this.state.mode === "cloud") return;
    const { record, attempt } = this.lockAuthentication();
    if (record?.pendingLogout)
      void this.retryLogout(record, this.epoch, attempt);
  }
  async signOut() {
    if (this.disposed) return;
    const { record, attempt } = this.lockAuthentication();
    if (record?.pendingLogout)
      await this.retryLogout(record, this.epoch, attempt);
  }
  async register(
    username: string,
    password: string,
    inviteCode: string,
  ): Promise<RegistrationResult> {
    const failed = { registered: false };
    if (this.disposed) return failed;
    if (this.config.state !== "ready") {
      this.update({
        ...registrationError("REGISTRATION_UNAVAILABLE"),
        busy: false,
      });
      return failed;
    }
    if (!isValidUsername(username)) {
      this.update({ ...registrationError("INVALID_USERNAME"), busy: false });
      return failed;
    }
    if (
      password.length < 8 ||
      new TextEncoder().encode(password).length > 1024
    ) {
      this.update({ ...registrationError("INVALID_PASSWORD"), busy: false });
      return failed;
    }
    if (!inviteCode) {
      this.update({ ...registrationError("INVITE_REQUIRED"), busy: false });
      return failed;
    }
    this.invalidate();
    this.update({ busy: true, error: null });
    const epoch = this.epoch;
    const abort = new AbortController();
    this.registrationAbort = abort;
    try {
      const response = await this.registerFetch.call(
        globalThis,
        "/api/register",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password, inviteCode }),
          signal: abort.signal,
        },
      );
      if (!this.current(epoch)) return failed;
      if (response.status !== 201) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          /* Never display raw provider text. */
        }
        if (!this.current(epoch)) return failed;
        this.registrationAbort = null;
        const code =
          body && typeof body === "object" && "code" in body
            ? body.code
            : undefined;
        const fallback =
          response.status === 429
            ? "RATE_LIMITED"
            : response.status >= 500
              ? "REGISTRATION_UNAVAILABLE"
              : "REGISTRATION_FAILED";
        this.update({
          ...registrationError(isRegistrationErrorCode(code) ? code : fallback),
          busy: false,
        });
        return failed;
      }
      // Consume the complete successful response too before accepting creation.
      await response.arrayBuffer();
      if (!this.current(epoch)) return failed;
      this.registrationAbort = null;
      const loginEpoch = this.epoch + 1;
      const signedIn = await this.signIn(username, password);
      if (signedIn === undefined || !this.current(loginEpoch)) return failed;
      if (!signedIn) this.update({ error: "账号已创建，请登录", busy: false });
      return { registered: true };
    } catch {
      if (this.current(epoch)) {
        this.registrationAbort = null;
        this.update({ error: "注册请求失败，请检查网络。", busy: false });
      }
      return failed;
    }
  }
  async enterLocal() {
    if (this.disposed || this.state.privateMode) return;
    this.stop();
    const epoch = this.epoch;
    await this.store.activate("local");
    if (this.current(epoch))
      this.update({
        mode: "local",
        displayName: null,
        error: null,
        busy: false,
      });
  }
  async enterCloud() {
    if (this.disposed) return;
    this.invalidate();
    await this.startRestore(this.epoch);
  }
  dispose() {
    if (this.disposed) return;
    if (this.state.busy) {
      const { record, attempt } = this.lockAuthentication();
      if (record?.pendingLogout) void this.retryLogout(record, -1, attempt);
    } else this.invalidate();
    this.disposed = true;
    this.offAuth?.();
    this.offStore?.();
    this.authLock.close();
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.foreground);
      document.removeEventListener("visibilitychange", this.foreground);
    }
    this.listeners.clear();
  }
}
export async function bootstrapCloud(
  options: CloudDependencies & {
    store?: TrackerStore;
    env?: Record<string, unknown>;
  } = {},
): Promise<CloudController> {
  return new CloudController(
    options.store ?? trackerStore,
    readCloudConfig(options.env ?? import.meta.env),
    options,
  ).initialize();
}
export function createCloudController(
  options: CloudDependencies & {
    store?: TrackerStore;
    env?: Record<string, unknown>;
  } = {},
): CloudController {
  return new CloudController(
    options.store ?? trackerStore,
    readCloudConfig(options.env ?? import.meta.env),
    options,
  );
}
