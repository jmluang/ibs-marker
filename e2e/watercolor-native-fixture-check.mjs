// Infrastructure-only preflight. Reads existing dist; never builds or browses.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "http://127.0.0.1:15009";
const evidence = resolve(process.env.IBS_EVIDENCE_DIR || resolve(root, "../ibs-marker-verification/watercolor-ui/e"));
const probe = createServer();
await new Promise((r, j) => { probe.once("error", j); probe.listen(15009, "127.0.0.1", r); });
await new Promise((r) => probe.close(r));
const distDir = resolve(process.env.WATERCOLOR_DIST_DIR || resolve(root, "../ibs-marker-verification/watercolor-ui/release/dist"));
const child = spawn(process.execPath, ["e2e/watercolor-production.server.mjs"], { cwd: root, env: { ...process.env, WATERCOLOR_DIST_DIR: distDir }, stdio: ["ignore", "pipe", "pipe"] });
let log = "", stderr = "", result, startup;
child.stderr.on("data", (chunk) => { stderr += chunk; });
const exit = once(child, "exit");
try {
  await new Promise((r, j) => {
    const timer = setTimeout(() => j(Error("FIXTURE_START_TIMEOUT")), 15000);
    child.stdout.on("data", (chunk) => { log += chunk; if (log.includes('"fixture":"watercolor-native"')) { clearTimeout(timer); r(); } });
    child.once("error", (e) => { clearTimeout(timer); j(e); });
    child.once("exit", () => { clearTimeout(timer); j(Error("FIXTURE_EXIT: " + stderr)); });
  });
  startup = JSON.parse(log.trim().split("\n").find((line) => line.includes('"fixture":"watercolor-native"')));
  assert.equal(startup.distDir, distDir);
  let cookie = "";
  const regressions = [];
  async function regression(name, run) {
    try { await run(); regressions.push({ name, ok: true }); }
    catch (error) { regressions.push({ name, ok: false, error: error.message }); }
    console.log(JSON.stringify(regressions.at(-1)));
  }
  const reorder = (value) => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  async function call(path, body, headers = {}, expected = 200) {
    const r = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    assert.equal(r.status, expected, path + ": " + await (r.status === expected ? Promise.resolve("") : r.clone().text()));
    if (r.headers.get("set-cookie")) { assert.match(r.headers.get("set-cookie"), /HttpOnly/); cookie = r.headers.get("set-cookie").split(";")[0]; }
    return r.json();
  }
  const doc = await fetch(origin + "/?fixture=preflight"); assert.equal(doc.status, 200); assert.match(doc.headers.get("content-type"), /text\/html/); const html = await doc.text(); assert.match(html, /<script/);
  const manifest = await (await fetch(origin + "/asset-manifest.json")).json();
  assert.equal(manifest.buildId, startup.buildId);
  let fontAssetCount = 0;
  for (const asset of manifest.assets) {
    const response = await fetch(origin + asset); assert.equal(response.status, 200, asset);
    assert.equal(response.headers.get("cache-control"), ["/", "/index.html"].includes(asset) ? "no-store" : "no-cache", asset);
    if (asset.endsWith(".woff2")) { assert.equal(response.headers.get("content-type"), "font/woff2"); fontAssetCount++; }
    await response.arrayBuffer();
  }
  assert.ok(fontAssetCount > 0);
  const worker = await fetch(origin + "/sw.js?build=" + manifest.buildId); assert.equal(worker.status, 200); assert.match(worker.headers.get("content-type"), /javascript/); await worker.text();
  await call("/readyz"); await call("/__fixture/reset", {});
  let auth = await call("/api/auth/bootstrap", {}); assert.equal(auth.user, null);
  const prepared = await call("/api/auth/prepare", { authRevision: auth.authRevision });
  auth = await call("/api/auth/login", { ...prepared, ok: undefined, username: "Alice", password: " raw password " });
  assert.equal(auth.user.id, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(await call("/api/auth/session"), auth);
  const at = "2026-10-23T04:00:00.000Z";
  const entry = { id: randomUUID(), kind: "meal", occurredAt: at, createdAt: at, updatedAt: at, estimatedTime: false, deletedAt: null, note: "synthetic-only", status: "eaten", slot: "lunch", foods: "fixture rice", tags: ["rice", "warm"], portion: "medium" };
  assert.equal((await call("/__fixture/seed", { username: "Alice", entries: [entry] })).seeded, 1);
  const revision = { "X-Auth-Revision": auth.authRevision };
  let pull = await call("/api/sync/pull?cursor=0&limit=100", undefined, revision); assert.equal(pull.rows.length, 1); assert.deepEqual(pull.rows[0].remote.snapshot, entry);
  let op = { kind: "entry", resourceId: entry.id, changeId: randomUUID(), baseVersion: 1, snapshot: { ...entry, note: "edited" }, tombstone: false };
  let push = await call("/api/sync/push", { operation: op }, revision); assert.equal(push.result.status, "applied"); assert.equal(push.result.remote.version, 2);
  const firstOp = structuredClone(op), firstPush = structuredClone(push);
  await regression("same input replays first applied result", async () => assert.deepEqual(await call("/api/sync/push", { operation: op }, revision), firstPush));
  await regression("object key order does not change operation identity", async () => assert.deepEqual(await call("/api/sync/push", { operation: reorder(op) }, revision), firstPush));
  await regression("changed payload rejects reused changeId", async () => { await call("/api/sync/push", { operation: { ...op, snapshot: { ...op.snapshot, note: "tampered" } } }, revision, 503); });
  await regression("array order remains significant", async () => { await call("/api/sync/push", { operation: { ...op, snapshot: { ...op.snapshot, tags: [...op.snapshot.tags].reverse() } } }, revision, 503); });
  const conflictOp = { ...op, changeId: randomUUID() };
  const conflict = await call("/api/sync/push", { operation: conflictOp }, revision); assert.equal(conflict.result.status, "conflict"); assert.equal(conflict.result.remote.version, 2);
  op = { ...op, changeId: randomUUID(), baseVersion: 2, snapshot: { ...op.snapshot, deletedAt: at }, tombstone: true };
  push = await call("/api/sync/push", { operation: op }, revision); assert.equal(push.result.remote.version, 3); assert.equal(push.result.remote.tombstone, true);
  await regression("conflict replays first remote after resource advances", async () => assert.deepEqual(await call("/api/sync/push", { operation: reorder(conflictOp) }, revision), conflict));
  await regression("applied result stays immutable after deletion", async () => assert.deepEqual(await call("/api/sync/push", { operation: firstOp }, revision), firstPush));
  await regression("conflict input cannot be replaced", async () => { await call("/api/sync/push", { operation: { ...conflictOp, baseVersion: 0 } }, revision, 503); });
  pull = await call("/api/sync/pull?cursor=1&limit=1", undefined, revision); assert.equal(pull.rows.length, 1); assert.equal(pull.rows[0].seq, 2);
  await call("/api/sync/pull?cursor=0&limit=100", undefined, { "X-Auth-Revision": "0".repeat(64) }, 409);
  await call("/__fixture/seed", { username: "Alice", entries: [{}] }, {}, 400);
  await call("/__fixture/unknown", undefined, {}, 404);
  await call("/__fixture/reset", undefined, {}, 405);
  await call("/__fixture/reset", {}, { Origin: "https://foreign.invalid" }, 403);
  const state = await call("/__fixture/state"); assert.equal(state.users[0].changeCount, 3); assert.equal(state.users[1].changeCount, 0); assert.ok(!/token|password|cookie|synthetic-only/.test(JSON.stringify(state)));
  await call("/api/auth/logout", { authRevision: auth.authRevision });
  auth = await call("/api/auth/session"); assert.equal(auth.user, null);
  const bob = await call("/api/auth/prepare", { authRevision: auth.authRevision });
  auth = await call("/api/auth/login", { authRevision: bob.authRevision, attemptId: bob.attemptId, username: "Bob", password: " raw password " });
  assert.equal(auth.user.id, "22222222-2222-4222-8222-222222222222");
  assert.equal((await call("/api/sync/pull?cursor=0&limit=100", undefined, { "X-Auth-Revision": auth.authRevision })).rows.length, 0);
  await regression("changeId is isolated by user", async () => {
    const bobOp = { ...firstOp, baseVersion: -0, snapshot: { ...entry, note: "Bob only" } };
    const bobRevision = { "X-Auth-Revision": auth.authRevision };
    const bobPush = await call("/api/sync/push", JSON.stringify({ operation: bobOp }).replace('"baseVersion":0', '"baseVersion":-0.0'), bobRevision);
    assert.equal(bobPush.result.status, "applied"); assert.equal(bobPush.result.remote.version, 1);
    assert.equal(bobPush.result.remote.snapshot.note, "Bob only");
    assert.deepEqual(await call("/api/sync/push", { operation: { ...reorder(bobOp), baseVersion: 0.0 } }, bobRevision), bobPush);
    const state = await call("/__fixture/state");
    assert.deepEqual(state.users.map((u) => [u.changeCount, u.resources[0].version]), [[3, 3], [1, 1]]);
  });
  await call("/__fixture/reset", {}); assert.ok((await call("/__fixture/state")).users.every((u) => u.resourceCount === 0 && u.changeCount === 0));
  assert.ok(regressions.every((test) => test.ok), JSON.stringify(regressions.filter((test) => !test.ok)));
  result = { ok: true, scope: "native infrastructure preflight, existing candidate dist only; no browser cold-SW or real cloud acceptance", node: process.version, distDir, regressions, buildId: manifest.buildId, staticAssetCount: manifest.assets.length, fontAssetCount, staticCacheHeaders: true, versionedWorker: true, nativeCookieLoginSession: true, seedPushPullCASIdempotencyDelete: true, userIsolation: true, safeControlEndpoints: true };
} finally {
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  const [code, signal] = await exit; clearTimeout(timeout);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await writeFile(resolve(evidence, "native-preflight.server.log"), log + stderr, { mode: 0o600 });
  assert.equal(code, 0, `fixture shutdown ${code}/${signal}: ${stderr}`); assert.equal(stderr, "");
  if (startup) await assert.rejects(access(startup.tempDir), { code: "ENOENT" });
  const closedProbe = createServer();
  await new Promise((r, j) => { closedProbe.once("error", j); closedProbe.listen(15009, "127.0.0.1", r); });
  await new Promise((r) => closedProbe.close(r));
  if (result) { result.ownedTempRemoved = true; result.ownedServerClosed = true; await writeFile(resolve(evidence, "native-preflight.json"), JSON.stringify(result, null, 2), { mode: 0o600 }); console.log(JSON.stringify(result)); }
}
