import {
  BFF_BOOTSTRAP_LOCK,
  isBackendErrorCode,
  type BackendSession,
  type BackendPrepare,
  type BackendUser,
} from "../domain/backendApi";

export interface BootstrapLocks {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<T>,
  ): Promise<T>;
}
export class BffError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
  ) {
    super(code);
    this.name = "BffError";
  }
}
export const validRevision = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
export function validUser(value: unknown): value is BackendUser {
  if (!value || typeof value !== "object") return false;
  const u = value as BackendUser;
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      u.id,
    ) &&
    typeof u.displayName === "string" &&
    u.displayName.length > 0 &&
    u.displayName.length <= 100
  );
}
export function parseSession(value: unknown): BackendSession {
  const s = value as BackendSession;
  if (
    !s ||
    s.ok !== true ||
    !validRevision(s.authRevision) ||
    (s.user !== null && !validUser(s.user))
  )
    throw new BffError("INVALID_RESPONSE");
  // Keep only the explicit noncredential contract, never cache extra server fields.
  return {
    ok: true,
    user:
      s.user === null
        ? null
        : { id: s.user.id, displayName: s.user.displayName },
    authRevision: s.authRevision,
  };
}
export class BffClient {
  constructor(
    readonly fetcher: typeof fetch = globalThis.fetch,
    readonly locks: BootstrapLocks | null | undefined = globalThis.navigator
      ?.locks,
  ) {}
  async request(
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      signal?: AbortSignal;
      revision?: string;
    } = {},
  ): Promise<unknown> {
    const response = await this.fetcher.call(globalThis, path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      headers: {
        ...(options.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(options.revision ? { "X-Auth-Revision": options.revision } : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
      signal: options.signal ?? new AbortController().signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      // A successful response body can still fail in transit. Preserve that
      // network failure, but HTTP auth failures remain authoritative even when
      // their error bodies are truncated or unreadable.
      if (response.ok && error instanceof TypeError) throw error;
      throw new BffError(
        response.ok ? "INVALID_RESPONSE" : "REQUEST_FAILED",
        response.status,
      );
    }
    if (!response.ok) {
      const code =
        body && typeof body === "object" && "code" in body
          ? body.code
          : undefined;
      throw new BffError(
        isBackendErrorCode(code)
          ? code
          : response.status === 429
            ? "RATE_LIMITED"
            : "REQUEST_FAILED",
        response.status,
      );
    }
    if (
      !body ||
      typeof body !== "object" ||
      !("ok" in body) ||
      body.ok !== true
    )
      throw new BffError("INVALID_RESPONSE");
    return body;
  }
  probe() {
    return this.request("/api/auth/session").then(parseSession);
  }
  async session(
    options: { onObserved?: (session: BackendSession) => void } = {},
  ): Promise<BackendSession> {
    const observe = (session: BackendSession) => {
      options.onObserved?.(session);
      return session;
    };
    // Without Web Locks only an already established context is usable. When
    // available, even valid probes enter the lock: bootstrap headers may have
    // applied a cookie before another tab has consumed its complete body.
    if (!this.locks) {
      try {
        return observe(await this.probe());
      } catch (error) {
        if (
          error instanceof BffError &&
          error.status === 428 &&
          error.code === "SESSION_CONTEXT_REQUIRED"
        )
          throw new BffError("BOOTSTRAP_UNSUPPORTED");
        throw error;
      }
    }
    return this.locks.request(
      BFF_BOOTSTRAP_LOCK,
      { mode: "exclusive" },
      async () => {
        // Reprobe after acquiring the cross-tab lock; another tab may have created SID.
        try {
          observe(await this.probe());
        } catch (error) {
          if (
            !(error instanceof BffError) ||
            error.status !== 428 ||
            error.code !== "SESSION_CONTEXT_REQUIRED"
          )
            throw error;
        }
        // Deliberately not linked to controller epochs or AbortSignal. Hold the lock
        // through complete body consumption and confirmation, even after cancellation.
        // Reissue a durable cookie even for healthy existing contexts. Parse and
        // observe each stage: a later outage must not resurrect an earlier user.
        observe(
          parseSession(
            await this.request("/api/auth/bootstrap", {
              method: "POST",
              body: {},
            }),
          ),
        );
        return observe(await this.probe());
      },
    );
  }
  async prepare(
    revision: string,
    signal: AbortSignal,
  ): Promise<BackendPrepare> {
    const p = (await this.request("/api/auth/prepare", {
      method: "POST",
      body: { authRevision: revision },
      signal,
    })) as BackendPrepare;
    if (
      !validRevision(p.authRevision) ||
      typeof p.attemptId !== "string" ||
      !p.attemptId ||
      p.attemptId.length > 256
    )
      throw new BffError("INVALID_RESPONSE");
    return { ok: true, authRevision: p.authRevision, attemptId: p.attemptId };
  }
}
export function loginError(error: unknown): string {
  if (error instanceof BffError) {
    if (error.code === "INVALID_CREDENTIALS")
      return "登录失败，请检查用户名和密码。";
    if (error.code === "RATE_LIMITED") return "请求过于频繁，请稍后再试。";
    if (error.code === "SESSION_CHANGED")
      return "账号会话已在其他操作中变更，请重新登录。";
    if (error.code === "BOOTSTRAP_UNSUPPORTED")
      return "当前浏览器不支持安全初始化登录，请使用支持 Web Locks 的浏览器。";
    return "暂时无法登录，请稍后重试。";
  }
  return "登录请求失败，请检查网络。";
}
