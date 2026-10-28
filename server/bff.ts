import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type {
  BackendErrorCode,
  BackendUser,
} from "../src/domain/backendApi.ts";
import {
  isValidUsername,
  usernameToInternalEmail,
} from "../src/domain/username.ts";
import {
  createFileSessionStore,
  newRevision,
  SessionChangedError,
  SessionStoreError,
} from "./sessionStore.ts";
import type {
  SessionStore,
  SessionContext,
  StoredAuth,
} from "./sessionStore.ts";
import {
  canonicalOperation,
  canonicalRemote,
  exact,
  record,
  uuid,
} from "./syncValidation.ts";
import type { JsonRequest } from "./curlTransport.ts";
export class BffFailure extends Error {
  status: number;
  code: BackendErrorCode;
  constructor(status: number, code: BackendErrorCode) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export interface BffConfig {
  publicOrigin: string;
  supabasePublicKey?: string;
  sessionStore?: SessionStore;
  sessionEncryptionKey?: string;
  serverSessionFile?: string;
  upstreamTimeoutMs?: number;
}
function fail(status: number, code: BackendErrorCode): never {
  throw new BffFailure(status, code);
}
const machine = (v: unknown) =>
  record(v)
    ? typeof v.error_code === "string"
      ? v.error_code
      : typeof v.code === "string"
        ? v.code
        : undefined
    : undefined;
const invalidRefresh = (status: number, body: unknown) =>
  [400, 401, 403].includes(status) &&
  [
    "refresh_token_not_found",
    "refresh_token_already_used",
    "invalid_refresh_token",
    "session_not_found",
    "session_expired",
    "user_not_found",
    "user_banned",
  ].includes(machine(body) ?? "");
const definitiveUser = (status: number, body: unknown) =>
  [401, 403].includes(status) &&
  [
    "bad_jwt",
    "invalid_jwt",
    "no_authorization",
    "session_not_found",
    "session_expired",
    "user_not_found",
    "user_banned",
  ].includes(machine(body) ?? "");
export function createBff(
  config: BffConfig,
  origin: string,
  transport: JsonRequest,
  now: () => number,
) {
  const timeout = config.upstreamTimeoutMs ?? 12000;
  if (!Number.isSafeInteger(timeout) || timeout < 1)
    throw new Error("INVALID_UPSTREAM_TIMEOUT");
  let store = config.sessionStore;
  if (!store) {
    if (!config.sessionEncryptionKey || !config.serverSessionFile)
      throw new SessionStoreError();
    store = createFileSessionStore({
      path: config.serverSessionFile,
      encryptionKey: config.sessionEncryptionKey,
      now,
    });
  }
  const cookieName = (() => {
    try {
      const u = new URL(config.publicOrigin);
      return u.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
        ? "ibs_session"
        : "__Host-ibs_session";
    } catch {
      return "__Host-ibs_session";
    }
  })();
  const requireStore = () => {
    if (!store) fail(503, "AUTH_UNAVAILABLE");
    return store!;
  };
  const readSid = (req: IncomingMessage) => {
    const values = (req.headers.cookie ?? "")
      .split(";")
      .map((x) => x.trim())
      .filter((x) => x.startsWith(cookieName + "="));
    if (values.length !== 1) return "";
    const value = values[0].slice(cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(value) ? value : "";
  };
  const context = (sid: string) => {
    const c = requireStore().get(sid);
    if (!c) fail(428, "SESSION_CONTEXT_REQUIRED");
    return c!;
  };
  const current = (sid: string, revision: string) => {
    const c = requireStore().get(sid);
    if (!c || c.authRevision !== revision) fail(409, "SESSION_CHANGED");
    return c!;
  };
  const cas = (
    sid: string,
    rev: string,
    change: (c: SessionContext) => void,
    attempt?: string,
  ) => {
    try {
      return requireStore().cas(sid, rev, change, attempt);
    } catch (e) {
      if (e instanceof SessionChangedError) fail(409, "SESSION_CHANGED");
      throw e;
    }
  };
  const clear = (sid: string, rev: string) =>
    cas(sid, rev, (c) => {
      c.auth = null;
      c.attemptId = null;
      c.authRevision = newRevision();
    });
  const response = (c: SessionContext) => ({
    ok: true as const,
    user: c.auth
      ? { id: c.auth.user.id, displayName: c.auth.user.displayName }
      : null,
    authRevision: c.authRevision,
  });
  const call: JsonRequest = async (input) => {
    if (!origin || !config.supabasePublicKey) fail(503, "AUTH_UNAVAILABLE");
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        transport({ ...input, signal: abort.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new BffFailure(503, "AUTH_UNAVAILABLE"));
          }, timeout);
          timer.unref();
        }),
      ]);
    } catch {
      fail(503, "AUTH_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
  };
  const headers = (token?: string) => ({
    apikey: config.supabasePublicKey ?? "",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
  function checkedUser(value: unknown, expected: string): BackendUser {
    if (
      !record(value) ||
      !uuid(value.id) ||
      value.id !== expected ||
      !record(value.app_metadata) ||
      !isValidUsername(value.app_metadata.ibs_marker_username)
    )
      return fail(503, "AUTH_UNAVAILABLE");
    return {
      id: value.id,
      displayName: value.app_metadata.ibs_marker_username as string,
    };
  }
  function tokens(value: unknown): {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    id: string;
  } {
    if (
      !record(value) ||
      typeof value.access_token !== "string" ||
      !value.access_token ||
      value.access_token.length > 16384 ||
      /[\x00-\x20\x7f]/.test(value.access_token) ||
      typeof value.refresh_token !== "string" ||
      !value.refresh_token ||
      value.refresh_token.length > 16384 ||
      !record(value.user) ||
      !uuid(value.user.id) ||
      typeof value.expires_in !== "number" ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0 ||
      value.expires_in > 365 * 24 * 3600
    )
      return fail(503, "AUTH_UNAVAILABLE");
    return {
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresAt: now() + value.expires_in * 1000,
      id: value.user.id,
    };
  }
  // Each network continuation is fenced, including a rejected Promise.
  async function fenced(
    sid: string,
    rev: string,
    input: Parameters<JsonRequest>[0],
  ) {
    try {
      const r = await call(input);
      current(sid, rev);
      return r;
    } catch (e) {
      current(sid, rev);
      throw e;
    }
  }
  const flights = new Map<string, Promise<StoredAuth>>();
  async function refresh(
    sid: string,
    rev: string,
    captured: StoredAuth,
  ): Promise<StoredAuth> {
    const latest = current(sid, rev);
    const key = createHash("sha256")
      .update(sid + rev)
      .digest("hex");
    const active = flights.get(key);
    if (active) return active;
    if (!latest.auth) fail(409, "SESSION_CHANGED");
    if (latest.auth.refreshToken !== captured.refreshToken)
      return authenticated(sid, latest);
    const flight = (async () => {
      const r = await fenced(sid, rev, {
        method: "POST",
        url: origin + "/auth/v1/token?grant_type=refresh_token",
        headers: headers(),
        body: { refresh_token: captured.refreshToken },
      });
      if (r.status !== 200) {
        if (invalidRefresh(r.status, r.body)) {
          clear(sid, rev);
          fail(401, "SESSION_EXPIRED");
        }
        if (r.status === 429) fail(429, "RATE_LIMITED");
        fail(503, "AUTH_UNAVAILABLE");
      }
      const t = tokens(r.body);
      if (t.id !== captured.user.id) {
        clear(sid, rev);
        fail(401, "SESSION_EXPIRED");
      }
      // Rotation must survive a crash even if subsequent /user verification is unavailable.
      const saved = cas(sid, rev, (c) => {
        if (!c.auth) fail(409, "SESSION_CHANGED");
        c.auth = {
          user: captured.user,
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          expiresAt: t.expiresAt,
          needsVerification: true,
        };
      }).auth!;
      const u = await fenced(sid, rev, {
        method: "GET",
        url: origin + "/auth/v1/user",
        headers: headers(saved.accessToken),
      });
      if (u.status !== 200) {
        if (definitiveUser(u.status, u.body)) {
          clear(sid, rev);
          fail(401, "SESSION_EXPIRED");
        }
        if (u.status === 429) fail(429, "RATE_LIMITED");
        fail(503, "AUTH_UNAVAILABLE");
      }
      const user = checkedUser(u.body, captured.user.id);
      const final = cas(sid, rev, (c) => {
        if (!c.auth) fail(409, "SESSION_CHANGED");
        c.auth.user = user;
        c.auth.needsVerification = false;
      }).auth!;
      return final;
    })();
    flights.set(key, flight);
    try {
      return await flight;
    } finally {
      if (flights.get(key) === flight) flights.delete(key);
    }
  }
  async function authenticated(
    sid: string,
    c: SessionContext,
    verify = false,
  ): Promise<StoredAuth> {
    c = current(sid, c.authRevision);
    if (!c.auth) fail(401, "UNAUTHENTICATED");
    const active = flights.get(
      createHash("sha256")
        .update(sid + c.authRevision)
        .digest("hex"),
    );
    if (active) {
      const auth = await active;
      current(sid, c.authRevision);
      return auth;
    }
    let auth = c.auth!;
    if (auth.expiresAt <= now() + 30000)
      auth = await refresh(sid, c.authRevision, auth);
    else if (verify || auth.needsVerification) {
      const r = await fenced(sid, c.authRevision, {
        method: "GET",
        url: origin + "/auth/v1/user",
        headers: headers(auth.accessToken),
      });
      const latest = current(sid, c.authRevision);
      if (latest.auth?.accessToken !== auth.accessToken)
        return authenticated(sid, latest, verify);
      if (r.status === 401) auth = await refresh(sid, c.authRevision, auth);
      else if (r.status === 200) {
        const user = checkedUser(r.body, auth.user.id);
        auth = cas(sid, c.authRevision, (x) => {
          if (!x.auth) fail(409, "SESSION_CHANGED");
          x.auth.user = user;
          x.auth.needsVerification = false;
        }).auth!;
      } else {
        if (definitiveUser(r.status, r.body)) {
          clear(sid, c.authRevision);
          fail(401, "SESSION_EXPIRED");
        }
        if (r.status === 429) fail(429, "RATE_LIMITED");
        fail(503, "AUTH_UNAVAILABLE");
      }
    }
    current(sid, c.authRevision);
    return auth;
  }
  async function syncCall(
    sid: string,
    c: SessionContext,
    input: Omit<Parameters<JsonRequest>[0], "headers">,
  ) {
    let auth = await authenticated(sid, c);
    current(sid, c.authRevision);
    let r = await fenced(sid, c.authRevision, {
      ...input,
      headers: headers(auth.accessToken),
    });
    if (r.status === 401) {
      // Another request may already have rotated this generation's token.
      const latest = current(sid, c.authRevision).auth!;
      auth =
        latest.accessToken !== auth.accessToken
          ? await authenticated(sid, current(sid, c.authRevision))
          : await refresh(sid, c.authRevision, auth);
      current(sid, c.authRevision);
      r = await fenced(sid, c.authRevision, {
        ...input,
        headers: headers(auth.accessToken),
      });
    }
    if (r.status === 401) fail(401, "UNAUTHENTICATED");
    if (r.status === 403) fail(403, "FORBIDDEN");
    if (r.status === 429) fail(429, "RATE_LIMITED");
    if (r.status < 200 || r.status >= 300) {
      if (machine(r.body) === "23505") fail(409, "23505");
      fail(503, "SYNC_UNAVAILABLE");
    }
    return r.body;
  }
  function requireExact(body: unknown, keys: readonly string[]) {
    try {
      exact(body, keys);
    } catch {
      fail(400, "INVALID_REQUEST");
    }
    return body as Record<string, unknown>;
  }
  function revision(body: Record<string, unknown>) {
    if (
      typeof body.authRevision !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.authRevision)
    )
      fail(400, "INVALID_REQUEST");
    return body.authRevision as string;
  }
  // Only explicit bootstrap may deliver/upgrade a cookie. Its lifetime never
  // exceeds the existing server context, and reissue never rotates the SID.
  const setContextCookie = (
    res: ServerResponse,
    sid: string,
    c: SessionContext,
  ) => {
    const maxAge = Math.max(0, Math.floor((c.expiresAt - now()) / 1000));
    res.setHeader(
      "Set-Cookie",
      `${cookieName}=${sid}; Path=/; HttpOnly;${cookieName.startsWith("__Host-") ? " Secure;" : ""} SameSite=Strict; Max-Age=${maxAge}`,
    );
  };
  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ) => {
    const path = req.url!;
    const sid = readSid(req);
    if (path === "/api/auth/bootstrap") {
      requireExact(body, []);
      let c = requireStore().get(sid);
      if (c) {
        if (c.auth) {
          await authenticated(sid, c, true);
          c = current(sid, c.authRevision);
        }
        setContextCookie(res, sid, c);
        return response(c);
      }
      let created;
      try {
        created = requireStore().create();
      } catch (e) {
        if (e instanceof SessionChangedError) fail(503, "AUTH_UNAVAILABLE");
        throw e;
      }
      setContextCookie(res, created.sid, created.context);
      return response(created.context);
    }
    const c = context(sid);
    if (path === "/api/auth/session") {
      if (c.auth) {
        await authenticated(sid, c, true);
        return response(current(sid, c.authRevision));
      }
      return response(c);
    }
    if (path === "/api/auth/prepare") {
      const b = requireExact(body, ["authRevision"]);
      const prepared = cas(sid, revision(b), (x) => {
        x.auth = null;
        x.authRevision = newRevision();
        x.attemptId = newRevision();
      });
      return {
        ok: true,
        authRevision: prepared.authRevision,
        attemptId: prepared.attemptId,
      };
    }
    if (path === "/api/auth/logout") {
      const b = requireExact(body, ["authRevision"]);
      const rev = revision(b);
      current(sid, rev);
      const old = c.auth;
      const cleared = clear(sid, rev); // Durable logout BEFORE any provider await; never roll back.
      if (old)
        try {
          await call({
            method: "POST",
            url: origin + "/auth/v1/logout?scope=local",
            headers: headers(old.accessToken),
            body: {},
          });
        } catch {
          /* local durable logout remains effective */
        }
      return { ok: true, authRevision: cleared.authRevision };
    }
    if (path === "/api/auth/login") {
      const b = requireExact(body, [
        "username",
        "password",
        "attemptId",
        "authRevision",
      ]);
      const rev = revision(b);
      if (
        typeof b.attemptId !== "string" ||
        !/^[a-f0-9]{64}$/.test(b.attemptId)
      )
        fail(400, "INVALID_REQUEST");
      if (typeof b.username !== "string" || !isValidUsername(b.username))
        fail(400, "INVALID_USERNAME");
      if (
        typeof b.password !== "string" ||
        !b.password ||
        Buffer.byteLength(b.password) > 1024
      )
        fail(400, "INVALID_PASSWORD");
      const check = () => {
        const x = current(sid, rev);
        if (x.attemptId !== b.attemptId) fail(409, "SESSION_CHANGED");
      };
      check();
      const r = await fenced(sid, rev, {
        method: "POST",
        url: origin + "/auth/v1/token?grant_type=password",
        headers: headers(),
        body: {
          email: usernameToInternalEmail(b.username),
          password: b.password,
        },
      });
      check();
      if (r.status !== 200) {
        if (r.status === 429) fail(429, "RATE_LIMITED");
        if (
          [400, 401, 422].includes(r.status) &&
          machine(r.body) === "invalid_credentials"
        )
          fail(401, "INVALID_CREDENTIALS");
        fail(503, "AUTH_UNAVAILABLE");
      }
      const t = tokens(r.body);
      const u = await fenced(sid, rev, {
        method: "GET",
        url: origin + "/auth/v1/user",
        headers: headers(t.accessToken),
      });
      check();
      if (u.status === 429) fail(429, "RATE_LIMITED");
      if (u.status !== 200) fail(503, "AUTH_UNAVAILABLE");
      const user = checkedUser(u.body, t.id);
      if (user.displayName !== b.username) fail(503, "AUTH_UNAVAILABLE");
      const saved = cas(
        sid,
        rev,
        (x) => {
          x.auth = {
            user,
            accessToken: t.accessToken,
            refreshToken: t.refreshToken,
            expiresAt: t.expiresAt,
          };
          x.attemptId = null;
          x.authRevision = newRevision();
        },
        b.attemptId as string,
      );
      return response(saved);
    }
    // Sync requires current authenticated revision before validation or any upstream call.
    const rev = req.headers["x-auth-revision"];
    if (typeof rev !== "string" || rev !== c.authRevision)
      fail(409, "SESSION_CHANGED");
    if (!c.auth) fail(401, "UNAUTHENTICATED");
    if (path.startsWith("/api/sync/pull?")) {
      const query = new URL(path, "http://local.invalid").searchParams;
      if (
        [...query.keys()].length !== 2 ||
        query.getAll("cursor").length !== 1 ||
        query.getAll("limit").length !== 1
      )
        fail(400, "INVALID_REQUEST");
      const ct = query.get("cursor") ?? "",
        lt = query.get("limit") ?? "";
      const cursor = Number(ct),
        limit = Number(lt);
      if (
        !/^(0|[1-9]\d*)$/.test(ct) ||
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        !/^\d+$/.test(lt) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        fail(400, "INVALID_REQUEST");
      const result = await syncCall(sid, c, {
        method: "GET",
        url:
          origin +
          `/rest/v1/tracker_changes?select=seq,resource,change_id&seq=gt.${cursor}&order=seq.asc&limit=${limit}`,
      });
      try {
        if (!Array.isArray(result) || result.length > limit) throw Error();
        let last = cursor;
        const rows = result.map((row) => {
          if (
            !record(row) ||
            !Number.isSafeInteger(row.seq) ||
            (row.seq as number) <= last ||
            !uuid(row.change_id)
          )
            throw Error();
          last = row.seq as number;
          return {
            seq: row.seq,
            remote: canonicalRemote(row.resource),
            changeId: row.change_id,
          };
        });
        return { ok: true, rows };
      } catch {
        fail(503, "SYNC_UNAVAILABLE");
      }
    }
    if (path === "/api/sync/push") {
      let op;
      try {
        exact(body, ["operation"]);
        op = canonicalOperation(body.operation);
      } catch {
        fail(400, "INVALID_OPERATION");
      }
      const result = await syncCall(sid, c, {
        method: "POST",
        url: origin + "/rest/v1/rpc/tracker_apply_change",
        body: {
          p_change_id: op!.changeId,
          p_kind: op!.kind,
          p_resource_id: op!.resourceId,
          p_base_version: op!.baseVersion,
          p_snapshot: op!.snapshot,
          p_tombstone: op!.tombstone,
        },
      });
      try {
        if (
          !record(result) ||
          !["applied", "conflict"].includes(result.status as string)
        )
          throw Error();
        const remote = canonicalRemote(result.remote);
        if (remote.kind !== op!.kind || remote.resourceId !== op!.resourceId)
          throw Error();
        return { ok: true, result: { status: result.status, remote } };
      } catch {
        fail(503, "SYNC_UNAVAILABLE");
      }
    }
    fail(404, "INVALID_REQUEST");
  };
  return Object.assign(handle, {
    close() {
      if (!config.sessionStore) store?.close();
    },
  });
}
export function bffError(error: unknown) {
  if (error instanceof BffFailure)
    return { status: error.status, code: error.code };
  if (error instanceof SessionChangedError)
    return { status: 409, code: "SESSION_CHANGED" as const };
  if (error instanceof SessionStoreError)
    return { status: 503, code: "AUTH_UNAVAILABLE" as const };
  return { status: 503, code: "AUTH_UNAVAILABLE" as const };
}
