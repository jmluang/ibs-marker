import { createServer } from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  isValidUsername,
  usernameToInternalEmail,
} from "../src/domain/username.ts";
import type { JsonRequest } from "./curlTransport.ts";
import type { RegistrationErrorCode } from "../src/domain/authErrors.ts";
import { createBff, bffError } from "./bff.ts";
import type { SessionStore } from "./sessionStore.ts";

export interface ServerConfig {
  host?: string;
  port?: number;
  publicOrigin: string;
  additionalOrigins?: readonly string[];
  trustedProxyIPs?: readonly string[];
  inviteCode?: string;
  supabaseUrl?: string;
  supabasePublicKey?: string;
  supabaseSecretKey?: string;
  supabaseAccessToken?: string;
  supabaseProjectRef?: string;
  /** Explicit temporary startup mode; does not assert provider signup is closed. */
  allowProviderPublicSignup?: boolean;
  distDir?: string;
  bodyTimeoutMs?: number;
  upstreamTimeoutMs?: number;
  sessionStore?: SessionStore;
  sessionEncryptionKey?: string;
  serverSessionFile?: string;
  maxBodyBytes?: number;
  rateLimit?: {
    perIp: number;
    global: number;
    maxIps: number;
    windowMs: number;
  };
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const normalizeIP = (ip: string) =>
  ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
export function clientAddress(
  peer: string,
  headers: IncomingHttpHeaders,
  trusted: readonly string[] = [],
): string {
  const ip = normalizeIP(peer);
  const cf = headers["cf-connecting-ip"];
  return trusted.some((item) => normalizeIP(item) === ip && !!isIP(item)) &&
    typeof cf === "string" &&
    !!isIP(cf)
    ? normalizeIP(cf)
    : ip;
}
class HttpFailure extends Error {
  status: number;
  code: RegistrationErrorCode;
  constructor(status: number, code?: RegistrationErrorCode) {
    super("REQUEST_REJECTED");
    this.status = status;
    this.code =
      code ??
      (status === 429
        ? "RATE_LIMITED"
        : status === 503
          ? "REGISTRATION_UNAVAILABLE"
          : status >= 500
            ? "REGISTRATION_FAILED"
            : "INVALID_REQUEST");
  }
}
function send(res: ServerResponse, status: number, body: unknown) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  const result =
    object(body) && body.ok === false && !Object.hasOwn(body, "code")
      ? {
          ...body,
          code: status >= 500 ? "AUTH_UNAVAILABLE" : "INVALID_REQUEST",
        }
      : body;
  res.end(JSON.stringify(result));
}
async function readBody(
  req: IncomingMessage,
  max: number,
  timeout: number,
): Promise<unknown> {
  const length = req.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > max))
    throw new HttpFailure(413);
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("error", bad);
      req.removeListener("aborted", bad);
      if (error) {
        req.pause();
        reject(error);
      } else {
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          );
          resolveBody(JSON.parse(text));
        } catch {
          reject(new HttpFailure(400));
        }
      }
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) finish(new HttpFailure(413));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const bad = () => finish(new HttpFailure(400));
    const timer = setTimeout(() => finish(new HttpFailure(408)), timeout);
    timer.unref();
    req.on("data", data);
    req.once("end", end);
    req.once("error", bad);
    req.once("aborted", bad);
  });
}
const mime: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
};
/** Load a closed immutable snapshot, never arbitrary paths under the dist directory. */
function staticSnapshot(
  dist?: string,
): Map<string, { data: Buffer; type: string }> {
  const result = new Map<string, { data: Buffer; type: string }>();
  if (!dist) return result;
  try {
    const root = realpathSync(dist);
    const read = (name: string) => {
      const path = resolve(root, name);
      if (
        !path.startsWith(root + sep) ||
        lstatSync(path).isSymbolicLink() ||
        !lstatSync(path).isFile() ||
        !realpathSync(path).startsWith(root + sep)
      )
        throw Error();
      return readFileSync(path);
    };
    const manifestData = read("asset-manifest.json");
    const manifest: unknown = JSON.parse(manifestData.toString());
    if (
      !object(manifest) ||
      typeof manifest.buildId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(manifest.buildId) ||
      !Array.isArray(manifest.assets) ||
      manifest.assets.length > 1000 ||
      !manifest.assets.includes("/index.html")
    )
      return result;
    const known = new Set([
      "/",
      "/index.html",
      "/icon.svg",
      "/favicon.svg",
      "/icon-192.png",
      "/icon-512.png",
      "/stool-forms.svg",
      "/manifest.webmanifest",
    ]);
    const paths = new Set<string>(["/asset-manifest.json", ...manifest.assets]);
    try {
      read("sw.js");
      paths.add("/sw.js");
    } catch {
      /* optional service worker */
    }
    let size = 0;
    for (const path of paths) {
      if (
        typeof path !== "string" ||
        !(
          known.has(path) ||
          path === "/sw.js" ||
          path === "/asset-manifest.json" ||
          /^\/assets\/[A-Za-z0-9_-]+\.(?:js|css|png|svg|woff2?|ico)$/.test(path)
        )
      )
        throw Error();
      const data = path === "/" ? read("index.html") : read(path.slice(1));
      size += data.length;
      if (size > 32 * 1024 * 1024) throw Error();
      result.set(path, {
        data,
        type:
          mime[(path === "/" ? "index.html" : path).split(".").at(-1)!] ??
          "application/octet-stream",
      });
    }
    // Only this validated snapshot's exact build URL aliases its worker.
    const worker = result.get("/sw.js");
    if (worker) result.set(`/sw.js?build=${manifest.buildId}`, worker);
    return result;
  } catch {
    return new Map();
  }
}
/** Factory is import-safe: no env reads, network, or listeners until used. */
export function createApplication(
  config: ServerConfig,
  transport: JsonRequest,
  now: () => number = Date.now,
) {
  const inviteHash = createHash("sha256")
    .update(config.inviteCode ?? "")
    .digest();
  const origins = new Set(
    [config.publicOrigin, ...(config.additionalOrigins ?? [])].filter(
      (value) => {
        try {
          const u = new URL(value);
          return (
            ["https:", "http:"].includes(u.protocol) &&
            value === u.origin &&
            !u.username &&
            !u.password
          );
        } catch {
          return false;
        }
      },
    ),
  );
  let supabaseOrigin = "";
  try {
    const u = new URL(config.supabaseUrl ?? "");
    if (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash
    ) {
      supabaseOrigin = u.origin;
    }
  } catch {
    /* fail closed */
  }
  const configured = !!(
    config.inviteCode &&
    config.supabasePublicKey &&
    config.supabaseSecretKey &&
    supabaseOrigin &&
    origins.size
  );
  const files = staticSnapshot(config.distDir);
  function makeBudget(limits: NonNullable<ServerConfig["rateLimit"]>) {
    if (Object.values(limits).some((n) => !Number.isSafeInteger(n) || n <= 0))
      throw Error("INVALID_RATE_LIMIT");
    let reset = now() + limits.windowMs;
    let total = 0;
    const ips = new Map<string, number>();
    return (ip: string) => {
      const at = now();
      if (at >= reset) {
        ips.clear();
        total = 0;
        reset = at + limits.windowMs;
      }
      if (++total > limits.global) return false;
      const count = ips.get(ip) ?? 0;
      if (!count && ips.size >= limits.maxIps) return false;
      ips.set(ip, count + 1);
      return count < limits.perIp;
    };
  }
  const budget = makeBudget(
    config.rateLimit ?? {
      perIp: 8,
      global: 100,
      maxIps: 2000,
      windowMs: 60000,
    },
  );
  // Registration's tight default must not throttle ordinary session polling/sync.
  // Explicit fixture/deployment overrides intentionally remain a shared budget.
  const bffBudget = config.rateLimit
    ? budget
    : makeBudget({ perIp: 120, global: 2000, maxIps: 2000, windowMs: 60000 });
  // Strict mode requires explicit provider settings; never serve stale success.
  // The server-only temporary opt-in deliberately bypasses only this probe.
  // Share one bounded probe across readiness and registration, never public files.
  let readiness: { ok: boolean; expiresAt: number } | undefined;
  let readinessPending: Promise<boolean> | undefined;
  const ready = (): Promise<boolean> => {
    if (!configured) return Promise.resolve(false);
    if (config.allowProviderPublicSignup === true) return Promise.resolve(true);
    if (readinessPending) return readinessPending;
    if (readiness && now() < readiness.expiresAt)
      return Promise.resolve(readiness.ok);
    readinessPending = (async () => {
      let ok = false;
      try {
        const result = await transport({
          method: "GET",
          url: supabaseOrigin + "/auth/v1/settings",
          headers: { apikey: config.supabasePublicKey! },
        });
        ok =
          result.status === 200 &&
          object(result.body) &&
          result.body.disable_signup === true &&
          object(result.body.external) &&
          result.body.external.anonymous_users === false;
      } catch {
        // Unknown/network failures must close the gate, including after expiry.
      }
      readiness = { ok, expiresAt: now() + (ok ? 30000 : 2000) };
      return ok;
    })().finally(() => {
      readinessPending = undefined;
    });
    return readinessPending;
  };
  const adminHeaders = {
    apikey: config.supabaseSecretKey ?? "",
    Authorization: `Bearer ${config.supabaseSecretKey ?? ""}`,
  };
  const bff = createBff(config, supabaseOrigin, transport, now);
  const server = createServer(
    {
      maxHeaderSize: 8192,
      requestTimeout: 15000,
      headersTimeout: 10000,
      keepAliveTimeout: 3000,
    },
    async (req, res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      try {
        const path = req.url ?? "";
        // Only the two exact document pathnames accept arbitrary queries. Never
        // URL-decode/normalize targets or strip queries from API/asset lookups.
        const pathname = path.split("?", 1)[0];
        const shell = pathname === "/" || pathname === "/index.html";
        const file = files.get(shell ? "/index.html" : path);
        const safeRead = req.method === "GET" || req.method === "HEAD";
        if (safeRead && (file || shell)) {
          if (!file) {
            // A missing build is a document outage, not an authentication error.
            const html = Buffer.from(
              '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>暂时无法打开</title><h1>暂时无法打开</h1><p>请稍后重试。</p></html>',
            );
            res.writeHead(503, {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Length": html.length,
              "Cache-Control": "no-store",
            });
            res.end(req.method === "HEAD" ? undefined : html);
            return;
          }
          // Public immutable bytes may be navigated to from another site. No
          // cookies, identity, provider readiness or filesystem fallback here.
          res.writeHead(200, {
            "Content-Type": file.type,
            "Content-Length": file.data.length,
            "Cache-Control":
              shell || file === files.get("/sw.js") ? "no-store" : "no-cache",
          });
          res.end(req.method === "HEAD" ? undefined : file.data);
          return;
        }
        // Reject cross-site API reads as well as writes; never advertise CORS.
        const foreign =
          (req.headers.origin !== undefined &&
            (typeof req.headers.origin !== "string" ||
              !origins.has(req.headers.origin))) ||
          req.headers["sec-fetch-site"] === "cross-site";
        if (
          foreign &&
          path !== "/api/register" &&
          !path.startsWith("/api/auth/") &&
          !path.startsWith("/api/sync/")
        ) {
          send(res, 403, { ok: false, code: "INVALID_REQUEST" });
          return;
        }
        if (path.startsWith("/api/auth/") || path.startsWith("/api/sync/")) {
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Connection", "close");
          try {
            if (
              !bffBudget(
                clientAddress(
                  req.socket.remoteAddress ?? "",
                  req.headers,
                  config.trustedProxyIPs,
                ),
              )
            ) {
              send(res, 429, { ok: false, code: "RATE_LIMITED" });
              return;
            }
            if (foreign) {
              send(res, 403, { ok: false, code: "INVALID_REQUEST" });
              return;
            }
            const get =
              path === "/api/auth/session" ||
              path.startsWith("/api/sync/pull?");
            const known =
              get ||
              [
                "/api/auth/bootstrap",
                "/api/auth/prepare",
                "/api/auth/login",
                "/api/auth/logout",
                "/api/sync/push",
              ].includes(path);
            if (!known) {
              send(res, 404, { ok: false, code: "INVALID_REQUEST" });
              return;
            }
            if (req.method !== (get ? "GET" : "POST")) {
              send(res, 405, { ok: false, code: "INVALID_REQUEST" });
              return;
            }
            let body: unknown;
            if (!get) {
              if (
                typeof req.headers.origin !== "string" ||
                !origins.has(req.headers.origin)
              ) {
                send(res, 403, { ok: false, code: "INVALID_REQUEST" });
                return;
              }
              if (
                !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(
                  req.headers["content-type"] ?? "",
                ) ||
                req.headers["content-encoding"]
              ) {
                send(res, 415, { ok: false, code: "INVALID_REQUEST" });
                return;
              }
              body = await readBody(
                req,
                path === "/api/sync/push"
                  ? 262144
                  : (config.maxBodyBytes ?? 8192),
                config.bodyTimeoutMs ?? 5000,
              );
            }
            send(res, 200, await bff(req, res, body));
          } catch (error) {
            const e =
              error instanceof HttpFailure
                ? { status: error.status, code: "INVALID_REQUEST" }
                : bffError(error);
            send(res, e.status, { ok: false, code: e.code });
          }
          return;
        }
        if (path === "/healthz" && req.method === "GET") {
          send(res, 200, { ok: true });
          return;
        }
        if (path === "/readyz" && req.method === "GET") {
          const ok = files.has("/index.html") && (await ready());
          send(res, ok ? 200 : 503, {
            ok,
            ...(config.allowProviderPublicSignup === true
              ? { mode: "temporary-provider-public-signup" }
              : {}),
          });
          return;
        }
        if (path === "/api/register") {
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Connection", "close");
          if (req.method !== "POST") throw new HttpFailure(405);
          if (
            !budget(
              clientAddress(
                req.socket.remoteAddress ?? "",
                req.headers,
                config.trustedProxyIPs,
              ),
            )
          )
            throw new HttpFailure(429);
          if (
            foreign ||
            typeof req.headers.origin !== "string" ||
            !origins.has(req.headers.origin)
          )
            throw new HttpFailure(403);
          if (
            !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(
              req.headers["content-type"] ?? "",
            ) ||
            req.headers["content-encoding"]
          )
            throw new HttpFailure(415);
          const body = await readBody(
            req,
            config.maxBodyBytes ?? 8192,
            config.bodyTimeoutMs ?? 5000,
          );
          if (
            !object(body) ||
            Object.keys(body).length !== 3 ||
            !["username", "password", "inviteCode"].every((k) =>
              Object.hasOwn(body, k),
            ) ||
            typeof body.username !== "string" ||
            typeof body.password !== "string" ||
            typeof body.inviteCode !== "string"
          )
            throw new HttpFailure(400);
          if (!isValidUsername(body.username))
            throw new HttpFailure(400, "INVALID_USERNAME");
          if (
            body.password.length < 8 ||
            Buffer.byteLength(body.password) > 1024
          )
            throw new HttpFailure(400, "INVALID_PASSWORD");
          if (!body.inviteCode) throw new HttpFailure(400, "INVITE_REQUIRED");
          if (Buffer.byteLength(body.inviteCode) > 512)
            throw new HttpFailure(400, "INVITE_INVALID");
          if (!configured) throw new HttpFailure(503);
          const supplied = createHash("sha256")
            .update(body.inviteCode)
            .digest();
          if (!timingSafeEqual(inviteHash, supplied))
            throw new HttpFailure(403, "INVITE_INVALID");
          if (!(await ready())) throw new HttpFailure(503);
          const email = usernameToInternalEmail(body.username);
          const app_metadata = {
            ibs_marker_username: body.username,
            ibs_marker_registration: "invite",
          };
          const created = await transport({
            method: "POST",
            url: supabaseOrigin + "/auth/v1/admin/users",
            headers: adminHeaders,
            body: {
              email,
              password: body.password,
              email_confirm: true,
              app_metadata,
            },
          });
          if (created.status < 200 || created.status >= 300) {
            // GoTrue may use a numeric HTTP `code`; never inspect human text.
            const providerCode = object(created.body)
              ? typeof created.body.error_code === "string"
                ? created.body.error_code
                : typeof created.body.code === "string"
                  ? created.body.code
                  : undefined
              : undefined;
            if (created.status === 429) throw new HttpFailure(429);
            if (
              created.status === 409 ||
              (providerCode !== undefined &&
                [
                  "email_exists",
                  "user_already_exists",
                  "user_already_registered",
                ].includes(providerCode))
            )
              throw new HttpFailure(409, "USERNAME_TAKEN");
            if (
              providerCode === "weak_password" ||
              providerCode === "password_too_short"
            )
              throw new HttpFailure(400, "INVALID_PASSWORD");
            throw new HttpFailure(502);
          }
          const user =
            object(created.body) && object(created.body.user)
              ? created.body.user
              : created.body;
          if (
            !object(user) ||
            typeof user.id !== "string" ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
              user.id,
            )
          )
            throw new HttpFailure(502);
          const read = await transport({
            method: "GET",
            url: supabaseOrigin + "/auth/v1/admin/users/" + user.id,
            headers: adminHeaders,
          });
          if (read.status === 429) throw new HttpFailure(429);
          const verified =
            object(read.body) && object(read.body.user)
              ? read.body.user
              : read.body;
          if (
            read.status !== 200 ||
            !object(verified) ||
            verified.id !== user.id ||
            verified.email !== email ||
            typeof verified.email_confirmed_at !== "string" ||
            !Number.isFinite(Date.parse(verified.email_confirmed_at)) ||
            !object(verified.app_metadata) ||
            verified.app_metadata.ibs_marker_username !== body.username ||
            verified.app_metadata.ibs_marker_registration !== "invite"
          )
            throw new HttpFailure(502);
          send(res, 201, { ok: true });
          return;
        }
        if (path.startsWith("/api/") || path === "/api") {
          send(res, 404, { ok: false });
          return;
        }
        // No arbitrary path, filesystem or SPA fallback.
        send(res, 404, { ok: false });
      } catch (error) {
        send(res, error instanceof HttpFailure ? error.status : 502, {
          ok: false,
          ...(req.url === "/api/register"
            ? {
                code:
                  error instanceof HttpFailure
                    ? error.code
                    : "REGISTRATION_FAILED",
              }
            : {}),
        });
      }
    },
  );
  server.on("close", () => bff.close());
  server.maxConnections = 128;
  server.on("clientError", (_error, socket) => {
    if (socket.writable)
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    else socket.destroy();
  });
  return server;
}
