// Real native Node application; only its provider request transport is synthetic.
// No runtime config loader, dotenv, browser route fulfillment, or network upstream.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, chmod, rm, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApplication } from "../server/app.ts";
import { usernameToInternalEmail } from "../src/domain/username.ts";
import { canonicalOperation, canonicalRemote, record } from "../server/syncValidation.ts";

const origin = "http://127.0.0.1:15009";
const provider = "https://fixture.supabase.co";
const dist = resolve(process.env.WATERCOLOR_DIST_DIR || fileURLToPath(new URL("../../ibs-marker-verification/watercolor-ui/release/dist", import.meta.url)));
// Fail fast instead of silently serving a fake document or empty snapshot.
const manifest = JSON.parse(await readFile(resolve(dist, "asset-manifest.json"), "utf8"));
if (!Array.isArray(manifest.assets) || !manifest.assets.includes("/index.html")) throw Error("FIXTURE_DIST_INVALID");
const temp = await mkdtemp(resolve(process.env.TMPDIR || "/home/luang/.hermes/cache/scratch", "watercolor-node-"));
await chmod(temp, 0o700);
const accounts = new Map([ ["Alice", "11111111-1111-4111-8111-111111111111"], ["Bob", "22222222-2222-4222-8222-222222222222"] ].map(([name, id]) => [name, {
  user: { id, email: usernameToInternalEmail(name), email_confirmed_at: "2026-01-01T00:00:00.000Z", confirmed_at: "2026-01-01T00:00:00.000Z", app_metadata: { ibs_marker_username: name, rawName: name, ibs_marker_registration: "invite" } },
  resources: new Map(), changes: [], ledger: new Map(), seq: 0,
}]));
const access = new Map(), refresh = new Map();
let upstreamCalls = 0;
const reply = (status, body) => ({ status, body: structuredClone(body) });
function mint(account) {
  const pair = { account, access: "fixture-access-" + randomBytes(24).toString("hex"), refresh: "fixture-refresh-" + randomBytes(24).toString("hex") };
  access.set(pair.access, pair); refresh.set(pair.refresh, pair);
  return reply(200, { access_token: pair.access, refresh_token: pair.refresh, expires_in: 3600, token_type: "bearer", user: account.user });
}
function revoke(pair) { if (pair) { access.delete(pair.access); refresh.delete(pair.refresh); } }
function append(account, remote, changeId) {
  account.resources.set(`${remote.kind}:${remote.resourceId}`, structuredClone(remote));
  account.changes.push({ seq: ++account.seq, resource: structuredClone(remote), change_id: changeId });
}
// JSONB equality: object order is irrelevant, array order is not, and -0 = 0.
function sameJson(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((value, i) => sameJson(value, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}
const rpcError = (message) => reply(400, { code: "22023", details: null, hint: null, message });
const transport = async (input) => {
  const url = new URL(input.url);
  if (url.origin !== provider || url.username || url.password) throw Error("FIXTURE_UPSTREAM_ORIGIN_REJECTED");
  upstreamCalls++;
  const body = input.body;
  const bearer = input.headers?.Authorization || input.headers?.authorization || "";
  const pair = access.get(bearer.startsWith("Bearer ") ? bearer.slice(7) : "");
  if (input.method === "GET" && url.pathname === "/auth/v1/settings") return reply(200, { disable_signup: true, external: { anonymous_users: false } });
  if (input.method === "POST" && url.pathname === "/auth/v1/token") {
    if (url.search === "?grant_type=password") {
      const account = [...accounts.values()].find((a) => a.user.email === body?.email);
      return account && body.password === " raw password " ? mint(account) : reply(400, { error_code: "invalid_credentials" });
    }
    if (url.search === "?grant_type=refresh_token") {
      const old = refresh.get(body?.refresh_token);
      if (!old) return reply(400, { error_code: "refresh_token_not_found" });
      revoke(old); return mint(old.account);
    }
    throw Error("FIXTURE_GRANT_REJECTED");
  }
  if (!pair) return reply(401, { error_code: "session_not_found" });
  const account = pair.account;
  if (input.method === "GET" && url.pathname === "/auth/v1/user" && !url.search) return reply(200, account.user);
  if (input.method === "POST" && url.pathname === "/auth/v1/logout" && url.search === "?scope=local") { revoke(pair); return reply(204, null); }
  if (input.method === "GET" && url.pathname === "/rest/v1/tracker_changes") {
    const cursorText = url.searchParams.get("seq") || "";
    const limitText = url.searchParams.get("limit") || "";
    if (!/^gt\.\d+$/.test(cursorText) || !/^\d+$/.test(limitText) || url.searchParams.get("select") !== "seq,resource,change_id" || url.searchParams.get("order") !== "seq.asc") throw Error("FIXTURE_QUERY_REJECTED");
    const cursor = Number(cursorText.slice(3)), limit = Number(limitText);
    if (!Number.isSafeInteger(cursor) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error("FIXTURE_QUERY_REJECTED");
    return reply(200, account.changes.filter((c) => c.seq > cursor).slice(0, limit));
  }
  if (input.method === "POST" && url.pathname === "/rest/v1/rpc/tracker_apply_change" && !url.search) {
    const op = canonicalOperation({ changeId: body.p_change_id, kind: body.p_kind, resourceId: body.p_resource_id, baseVersion: body.p_base_version, snapshot: body.p_snapshot, tombstone: body.p_tombstone });
    const { changeId, ...request } = op;
    const previous = account.ledger.get(changeId);
    if (previous) return sameJson(previous.input, request) ? reply(200, previous.result) : rpcError("CHANGE_ID_REUSED");
    const remote = account.resources.get(`${op.kind}:${op.resourceId}`);
    let result;
    if ((remote?.version || 0) !== op.baseVersion) {
      if (!remote) return rpcError("RESOURCE_NOT_FOUND");
      result = { status: "conflict", remote };
    } else {
      const next = canonicalRemote({ kind: op.kind, resourceId: op.resourceId, version: (remote?.version || 0) + 1, snapshot: op.snapshot, tombstone: op.tombstone });
      append(account, next, changeId);
      result = { status: "applied", remote: next };
    }
    // Append once for both outcomes; never expose ledger references to callers.
    account.ledger.set(changeId, structuredClone({ input: request, result }));
    return reply(200, result);
  }
  throw Error("FIXTURE_UPSTREAM_ROUTE_REJECTED");
};
let server;
let stopping;
async function close() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (server?.listening) { server.closeAllConnections(); await new Promise((r, j) => server.close((e) => e ? j(e) : r())); }
    else server?.emit("close");
    await rm(temp, { recursive: true, force: true });
  })();
  return stopping;
}
function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Connection": "close" });
  res.end(JSON.stringify(body));
}
async function controlBody(req) {
  if (req.headers["content-encoding"] || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || "")) throw { status: 415 };
  let size = 0; const chunks = [];
  const timer = setTimeout(() => req.destroy(), 5000); timer.unref();
  try {
    if (Number(req.headers["content-length"] || 0) > 262144) throw { status: 413 };
    for await (const chunk of req) { size += chunk.length; if (size > 262144) throw { status: 413 }; chunks.push(chunk); }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { clearTimeout(timer); }
}
async function control(req, res) {
  try {
    if (req.headers.host !== "127.0.0.1:15009" || (req.headers.origin && req.headers.origin !== origin) || req.headers["sec-fetch-site"] === "cross-site") return send(res, 403, { ok: false });
    const expected = { "/__fixture/reset": "POST", "/__fixture/seed": "POST", "/__fixture/state": "GET" }[req.url];
    if (!expected) return send(res, 404, { ok: false });
    if (req.method !== expected) return send(res, 405, { ok: false });
    if (expected === "GET") {
      if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] || 0)) return send(res, 400, { ok: false });
      return send(res, 200, { ok: true, syntheticOnly: true, upstreamCalls, users: [...accounts].map(([username, a]) => ({ username, userId: a.user.id, resourceCount: a.resources.size, changeCount: a.changes.length, seq: a.seq, resources: [...a.resources.values()].map(({ kind, resourceId, version, tombstone }) => ({ kind, resourceId, version, tombstone })) })) });
    }
    const body = await controlBody(req);
    if (req.url === "/__fixture/reset") {
      if (!record(body) || Object.keys(body).length) return send(res, 400, { ok: false });
      for (const a of accounts.values()) { a.resources.clear(); a.changes = []; a.ledger.clear(); a.seq = 0; }
      return send(res, 200, { ok: true });
    }
    if (!record(body) || !accounts.has(body.username) || !Array.isArray(body.entries) || body.entries.length > 1000 || Object.keys(body).some((k) => !["username", "entries", "settings"].includes(k))) return send(res, 400, { ok: false });
    const a = accounts.get(body.username);
    const values = body.entries.map((e) => ({ kind: "entry", resourceId: e.id, snapshot: e, tombstone: e.deletedAt !== null }));
    if (body.settings !== undefined) values.push({ kind: "settings", resourceId: "settings", snapshot: body.settings, tombstone: false });
    if (new Set(values.map((v) => `${v.kind}:${v.resourceId}`)).size !== values.length) return send(res, 400, { ok: false });
    const remotes = values.map((v) => canonicalRemote({ ...v, version: (a.resources.get(`${v.kind}:${v.resourceId}`)?.version || 0) + 1 }));
    for (const remote of remotes) append(a, remote, randomUUID());
    return send(res, 200, { ok: true, seeded: remotes.length });
  } catch (e) { if (!res.destroyed && !res.writableEnded) send(res, [413, 415].includes(e?.status) ? e.status : 400, { ok: false }); }
}
try {
  server = createApplication({
    host: "127.0.0.1", port: 15009, publicOrigin: origin, distDir: dist,
    supabaseUrl: provider, supabasePublicKey: "fixture-public-not-real", supabaseSecretKey: "fixture-secret-not-real", inviteCode: "watercolor-fixture-invite",
    sessionEncryptionKey: randomBytes(32).toString("hex"), serverSessionFile: resolve(temp, "sessions.enc"),
    rateLimit: { perIp: 100000, global: 1000000, maxIps: 100, windowMs: 60000 },
  }, transport);
  const listeners = server.listeners("request");
  if (listeners.length !== 1) throw Error("FIXTURE_UNEXPECTED_REQUEST_LISTENERS");
  server.removeListener("request", listeners[0]);
  server.on("request", (req, res) => { if ((req.url || "").startsWith("/__fixture")) void control(req, res); else listeners[0].call(server, req, res); });
  await new Promise((r, j) => { server.once("error", j); server.listen(15009, "127.0.0.1", r); });
  process.once("SIGTERM", () => { void close().catch(() => { process.exitCode = 1; }); });
  process.once("SIGINT", () => { void close().catch(() => { process.exitCode = 1; }); });
  console.log(JSON.stringify({ fixture: "watercolor-native", origin, distDir: dist, buildId: manifest.buildId, tempDir: temp, syntheticProviderTransport: true }));
} catch (e) { await close(); throw e; }
