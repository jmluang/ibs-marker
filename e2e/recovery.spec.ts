import { randomUUID } from "node:crypto";
import { test, expect, login, users } from "./bff.fixture";
const metadata = (page: import("@playwright/test").Page) => page.evaluate(() => JSON.parse(localStorage.getItem("ibs-marker-bff-auth-state")!));

test("healthy legacy cookie is upgraded on query refresh without changing SID, identity, revision or context expiry", async ({ page, context, bff }) => {
  await page.goto("/"); await login(page);
  const cookie = (await context.cookies(bff.origin)).find(c => c.name === bff.cookieName)!;
  const session = structuredClone(await bff.current());
  const expiry = Date.now() + 120_000;
  bff.contextExpires.set(cookie.value, expiry);
  await context.addCookies([{ name: cookie.name, value: cookie.value, url: bff.origin, httpOnly: true, sameSite: "Strict" }]);
  expect((await context.cookies(bff.origin)).find(c => c.name === bff.cookieName)!.expires).toBe(-1);
  const start = bff.calls.length;
  await page.goto("/index.html?upgrade=1");
  await expect(page.getByRole("navigation")).toBeVisible();
  expect(bff.calls.slice(start).filter(call => call.path.startsWith("/api/auth/")).map(call => call.path)).toEqual(["/api/auth/session", "/api/auth/bootstrap", "/api/auth/session"]);
  const upgraded = (await context.cookies(bff.origin)).find(c => c.name === bff.cookieName)!;
  expect(upgraded.value).toBe(cookie.value);
  expect(upgraded.expires).toBeGreaterThan(Date.now() / 1000 + 90);
  expect(upgraded.expires).toBeLessThanOrEqual(expiry / 1000 + 2);
  expect(bff.contextExpires.get(cookie.value)).toBe(expiry);
  expect(await bff.current()).toEqual(session);
  await page.reload(); await expect(page.getByRole("navigation")).toBeVisible();
});

test("503 preserves a verified unlocked identity; online recovery needs no password", async ({ page, bff }) => {
  await page.goto("/"); await login(page);
  const before = await metadata(page);
  bff.unavailable = true;
  await page.reload(); await expect(page.getByRole("navigation")).toBeVisible();
  expect(await metadata(page)).toEqual(before);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试连接", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("密码错误");
  bff.unavailable = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("button", { name: "重试连接", exact: true })).toHaveCount(0);
  await expect(page.getByText("云账号：Alice", { exact: true })).toBeVisible();
  expect((await metadata(page)).locked).toBe(false);
});

test("503 with no cache offers retry and restores a healthy cookie identity without login", async ({ page, context, bff }) => {
  const sid = randomUUID();
  bff.sessions.set(sid, { user: users.Alice, authRevision: randomUUID() });
  bff.contextExpires.set(sid, Date.now() + 600_000);
  await context.addCookies([{ name: bff.cookieName, value: sid, url: bff.origin, httpOnly: true, sameSite: "Strict" }]);
  bff.unavailable = true;
  await page.goto("/");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重试连接", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("密码错误");
  bff.unavailable = false;
  await page.getByRole("button", { name: "重试连接", exact: true }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
  expect((await metadata(page)).user).toEqual(users.Alice);
  expect(bff.calls.filter(call => call.path === "/api/auth/login")).toEqual([]);
});

for (const observed of ["null", "Bob", "new-revision"] as const) {
  test(`probe ${observed} then bootstrap 503 cannot reopen cached Alice`, async ({ page, bff }) => {
    await page.goto("/"); await login(page);
    const current = (await bff.current())!;
    if (observed === "null") current.user = null;
    if (observed === "Bob") current.user = users.Bob;
    if (observed === "new-revision") current.authRevision = randomUUID();
    bff.bootstrapFailure = { status: 503, code: "AUTH_UNAVAILABLE" };
    await page.reload();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("密码错误");
    await expect(page.getByRole("navigation")).toHaveCount(0);
    expect((await metadata(page)).locked).toBe(true);
    bff.bootstrapFailure = undefined;
    // The quarantined durable lock is not silently lifted on a later refresh.
    await page.reload();
    await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
  });
}
for (const [status, code, locked] of [[403, "FORBIDDEN", false], [403, "INVALID_REQUEST", false], [403, "unknown-secret", true], [401, "UNAUTHENTICATED", true], [409, "SESSION_CHANGED", true]] as const) {
  test(`sync ${status}/${code} ${locked ? "locks" : "preserves"} identity across refresh`, async ({ page, bff }) => {
    await page.goto("/"); await login(page);
    bff.syncFailure = { status, code };
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "立即同步", exact: true }).click();
    await expect.poll(async () => (await metadata(page)).locked).toBe(locked);
    await expect.poll(() => bff.calls.some(call => call.path === "/api/sync/pull" && call.status === status)).toBe(true);
    await expect(page.getByRole("navigation")).toHaveCount(locked ? 0 : 1);
    bff.syncFailure = undefined;
    await page.reload();
    if (locked) await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
    else await expect(page.getByRole("navigation")).toBeVisible();
    expect((await metadata(page)).locked).toBe(locked);
  });
}
