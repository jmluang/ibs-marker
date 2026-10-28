import { randomUUID } from "node:crypto";
import { test as base, expect, type BrowserContext, type Page, type Request, type Route } from "@playwright/test";
import type { BackendUser } from "../src/domain/backendApi";

export const users = {
  Alice: { id: "11111111-1111-4111-8111-111111111111", displayName: "Alice" },
  Bob: { id: "22222222-2222-4222-8222-222222222222", displayName: "Bob" },
};
export const password = " raw password ";
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
export type RequestRecord = { path: string; method: string; body: Record<string, unknown> | null; revision?: string; status?: number; userId?: string; tab?: number };
type Session = { user: BackendUser | null; authRevision: string; attemptId?: string };
/** Synthetic BFF contract, NOT provider or production-server acceptance. */
export class BffFixture {
  readonly calls: RequestRecord[] = [];
  readonly forbidden: string[] = [];
  readonly pageErrors: string[] = [];
  readonly sessions = new Map<string, Session>();
  readonly contextExpires = new Map<string, number>();
  syncFailure?: { status: number; code: string };
  sessionFailure?: { status: number; code: string };
  bootstrapFailure?: { status: number; code: string };
  private readonly tabIds = new WeakMap<Page, number>();
  private tabCount = 0;
  readonly cookieName = "ibs_fixture_context";
  beforeCommit?: (call: RequestRecord) => Promise<void>;
  beforeReply?: (call: RequestRecord) => Promise<void>;
  registerStatus = 201;
  registerCode: string | undefined;
  loginFailure = false;
  unavailable = false;
  apiOffline = false;
  pushUnavailable = false;
  pushCode: string | undefined;
  pullRows: unknown[] = [];
  constructor(readonly context: BrowserContext, readonly origin: string) {}
  async install() {
    this.context.on("page", page => this.watch(page));
    for (const page of this.context.pages()) this.watch(page);
    await this.context.route("**/*", route => this.route(route));
    // No realtime socket is necessary, including Vite's development HMR socket.
    await this.context.routeWebSocket(/.*/, socket => {
      const url = new URL(socket.url());
      if (url.host !== new URL(this.origin).host) this.forbidden.push(socket.url());
      socket.close();
    });
  }
  private watch(page: Page) {
    this.tabIds.set(page, ++this.tabCount);
    page.on("pageerror", error => this.pageErrors.push(error.stack || error.message));
  }
  private async route(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    // Never fulfill a provider request: external traffic is a test failure.
    if (url.origin !== this.origin) {
      this.forbidden.push(request.url());
      return route.abort("blockedbyclient");
    }
    if (/^\/(auth|rest)\//.test(url.pathname) || request.headers().authorization || request.headers().apikey) {
      this.forbidden.push(request.url());
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const call: RequestRecord = {
      path: url.pathname, method: request.method(), tab: this.tabIds.get(request.frame().page()),
      body: request.postData() ? request.postDataJSON() : null,
      revision: request.headers()["x-auth-revision"],
    };
    this.calls.push(call);
    if (this.apiOffline) return route.abort("internetdisconnected");
    const reply = async (status: number, json: unknown, headers: Record<string, string> = {}) => {
      call.status = status;
      await this.beforeReply?.(call);
      await route.fulfill({ status, json, headers: { "cache-control": "no-store", ...headers } }).catch(() => {});
    };
    const fail = (status: number, code: string) => reply(status, { ok: false, code });
    if (this.unavailable) return fail(503, "AUTH_UNAVAILABLE");
    const sid = this.sid(request);
    let session = sid ? this.sessions.get(sid) : undefined;
    if (url.pathname === "/api/auth/session" && request.method() === "GET") {
      if (this.sessionFailure) return fail(this.sessionFailure.status, this.sessionFailure.code);
      if (!session) return fail(428, "SESSION_CONTEXT_REQUIRED");
      return reply(200, { ok: true, user: session.user, authRevision: session.authRevision });
    }
    if (url.pathname === "/api/auth/bootstrap" && request.method() === "POST") {
      if (JSON.stringify(call.body) !== "{}") return fail(400, "INVALID_REQUEST");
      if (this.bootstrapFailure) return fail(this.bootstrapFailure.status, this.bootstrapFailure.code);
      await this.beforeCommit?.(call);
      const stableSid = session ? sid! : randomUUID();
      if (!session) {
        session = { user: null, authRevision: randomUUID() };
        this.sessions.set(stableSid, session);
        this.contextExpires.set(stableSid, Date.now() + 3_600_000);
      }
      // Upgrade old session cookies without rotating SID/revision or context TTL.
      const remaining = Math.max(1, Math.ceil(((this.contextExpires.get(stableSid) ?? Date.now()) - Date.now()) / 1000));
      return reply(200, { ok: true, user: session.user, authRevision: session.authRevision }, { "set-cookie": `${this.cookieName}=${stableSid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${remaining}` });
    }
    if (url.pathname === "/api/register" && request.method() === "POST") {
      return reply(this.registerStatus, this.registerCode ? { ok: false, code: this.registerCode, error: "provider-secret" } : { ok: true });
    }
    if (!session) return fail(428, "SESSION_CONTEXT_REQUIRED");
    await this.beforeCommit?.(call);
    if (url.pathname.startsWith("/api/auth/") && call.body?.authRevision !== session.authRevision) return fail(409, "SESSION_CHANGED");
    if (url.pathname === "/api/auth/prepare" && request.method() === "POST") {
      session.user = null;
      session.authRevision = randomUUID();
      session.attemptId = randomUUID();
      return reply(200, { ok: true, authRevision: session.authRevision, attemptId: session.attemptId });
    }
    if (url.pathname === "/api/auth/login" && request.method() === "POST") {
      if (!session.attemptId || call.body?.attemptId !== session.attemptId) return fail(409, "SESSION_CHANGED");
      if (this.loginFailure) return fail(401, "INVALID_CREDENTIALS");
      const user = users[call.body?.username as keyof typeof users];
      if (!user || call.body?.password !== password) return fail(401, "INVALID_CREDENTIALS");
      session.user = user;
      session.authRevision = randomUUID();
      session.attemptId = undefined;
      call.userId = user.id;
      return reply(200, { ok: true, user, authRevision: session.authRevision });
    }
    if (url.pathname === "/api/auth/logout" && request.method() === "POST") {
      session.user = null;
      session.authRevision = randomUUID();
      session.attemptId = undefined;
      return reply(200, { ok: true, authRevision: session.authRevision });
    }
    if (url.pathname.startsWith("/api/sync/")) {
      if (call.revision !== session.authRevision) return fail(409, "SESSION_CHANGED");
      if (!session.user) return fail(401, "UNAUTHENTICATED");
      call.userId = session.user.id;
      if (this.syncFailure) return fail(this.syncFailure.status, this.syncFailure.code);
      if (url.pathname === "/api/sync/pull" && request.method() === "GET") return reply(200, { ok: true, rows: this.pullRows });
      if (url.pathname === "/api/sync/push" && request.method() === "POST") {
        if (this.pushUnavailable) return fail(503, "SYNC_UNAVAILABLE");
        if (this.pushCode) return reply(409, { ok: false, code: this.pushCode, error: "provider-secret" });
        const op = call.body?.operation as Record<string, unknown>;
        return reply(200, { ok: true, result: { status: "applied", remote: { kind: op.kind, resourceId: op.resourceId, version: Number(op.baseVersion) + 1, snapshot: op.snapshot, tombstone: op.tombstone } } });
      }
    }
    this.forbidden.push(`${request.method()} ${url.pathname}`);
    return fail(404, "INVALID_REQUEST");
  }
  private sid(request: Request) { return /(?:^|;\s*)ibs_fixture_context=([^;]+)/.exec(request.headers().cookie || "")?.[1]; }
  async current() {
    const cookie = (await this.context.cookies(this.origin)).find(cookie => cookie.name === this.cookieName);
    return cookie ? this.sessions.get(cookie.value) : undefined;
  }
}
export const test = base.extend<{ bff: BffFixture }>({
  bff: [async ({ context, baseURL }, use, testInfo) => {
    const fixture = new BffFixture(context, new URL(baseURL!).origin);
    await fixture.install();
    await use(fixture);
    await testInfo.attach("bff-network", { body: JSON.stringify({ fixtureOnly: true, calls: fixture.calls, forbidden: fixture.forbidden, pageErrors: fixture.pageErrors }, null, 2), contentType: "application/json" });
    expect(fixture.forbidden, "all browser requests must stay on the fixture origin").toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
  }, { auto: true }],
});
// Keep the firewall effective even when these specs use a caller's root config.
// SW-owned fetches are a separate production Node acceptance boundary.
test.use({ serviceWorkers: "block" });
export { expect };
export async function login(page: Page, name: keyof typeof users = "Alice") {
  await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
  await page.getByLabel("用户名", { exact: true }).fill(name);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
}
export async function logout(page: Page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "退出本设备" }).click();
  await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
}
export async function storedPartition(page: Page, id: string) {
  return page.evaluate(async userId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ibs-marker-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<import("../src/domain/types").NamespaceData>((resolve, reject) => {
        const transaction = db.transaction("namespaces", "readonly");
        const read = transaction.objectStore("namespaces").get(`user:${userId}`);
        transaction.oncomplete = () => resolve(read.result);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }, id);
}
