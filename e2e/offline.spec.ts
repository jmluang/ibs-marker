import type { Page } from "@playwright/test";
import { test, expect, login, logout, users, storedPartition, deferred } from "./bff.fixture";
const note = "合成测试 · Alice 私有离线记录";
async function addRecord(page: Page, text = note) {
  await page.getByRole("button", { name: "补记如厕 ＋", exact: true }).click();
  await page.getByRole("group", { name: "有排出吗？", exact: true }).getByRole("button", { name: "无", exact: true }).click();
  await page.getByLabel("备注（可选）").fill(text);
  await page.getByRole("button", { name: "保存如厕记录", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(1);
}

test("BFF unreachable: same-user metadata restores local record and outbox; offline logout locks refresh", async ({ page, bff }, testInfo) => {
  // Deliberately NOT a production SW/cold-offline navigation claim. The shell is
  // served by isolated Vite; every API transport is blocked after login.
  bff.pushUnavailable = true;
  await page.goto("/"); await login(page);
  await addRecord(page);
  const before = await storedPartition(page, users.Alice.id);
  expect(Object.values(before.records)).toHaveLength(1);
  expect(before.outbox).toHaveLength(1);
  const metadata = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  expect(JSON.stringify(metadata)).not.toMatch(/access_token|refresh_token|authorization|bearer|sb-.*auth-token/i);
  bff.apiOffline = true;
  expect(await page.evaluate(async () => {
    try { await fetch("/api/offline-probe", { cache: "no-store" }); return false; }
    catch { return true; }
  })).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "肠记", exact: true })).toBeVisible();
  await expect(page.locator(".entry")).toContainText(note);
  const offline = await storedPartition(page, users.Alice.id);
  expect(offline.records).toEqual(before.records);
  expect(offline.outbox).toEqual(before.outbox);
  await page.getByRole("button", { name: "统计", exact: true }).click();
  await expect(page.getByTestId("stats-time-event")).toHaveCount(1);
  await expect(page.getByTestId("stats-time-event")).toHaveAttribute("data-result", "none");
  await expect(page.locator(".stats-compact-row").filter({ hasText: "不适报告 / 状态已知" })).toContainText("0 / 0 条");
  await expect(page.getByText("未知另列 1 条", { exact: false })).toBeVisible();
  await logout(page);
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(note);
  await page.reload();
  await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(note);
  const afterLogout = await storedPartition(page, users.Alice.id);
  expect(afterLogout.records).toEqual(before.records);
  expect(afterLogout.outbox).toEqual(before.outbox);
  await testInfo.attach("offline-boundary", { body: JSON.stringify({ fixtureOnly: true, productionSWVerified: false, apiTransportUnavailable: true, pending: before.outbox.length, offlineLogoutLocked: true }), contentType: "application/json" });
});

test("logout hides account A, B never receives A queue, relogin A retains pending operation", async ({ page, bff }) => {
  bff.pushUnavailable = true;
  await page.goto("/"); await login(page); await addRecord(page);
  const before = await storedPartition(page, users.Alice.id);
  await logout(page);
  await expect(page.locator("body")).not.toContainText(note);
  await login(page, "Bob");
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(note);
  await page.reload();
  await expect(page.locator("body")).not.toContainText(note);
  expect(bff.calls.filter(call => call.path === "/api/sync/push" && call.userId === users.Bob.id)).toEqual([]);
  await logout(page); await login(page);
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.locator(".entry")).toContainText(note);
  const after = await storedPartition(page, users.Alice.id);
  expect(after.records).toEqual(before.records);
  expect(after.outbox).toEqual(before.outbox);
});

test("safe BFF business code 23505 preserves queue without displaying raw provider text", async ({ page, bff }) => {
  bff.pushCode = "23505";
  await page.goto("/"); await login(page); await addRecord(page);
  const before = await storedPartition(page, users.Alice.id);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "立即同步", exact: true }).click();
  await expect(page.getByText(/正餐同日同餐次只能一条/)).toBeVisible();
  await expect(page.locator("body")).not.toContainText("provider-secret");
  await expect(page.getByRole("navigation")).toBeVisible();
  expect((await storedPartition(page, users.Alice.id)).outbox).toEqual(before.outbox);
  expect(bff.calls.some(call => call.path === "/api/sync/push" && call.status === 409 && !!call.revision)).toBe(true);
});

test("late A pull response after logout cannot populate B storage or UI", async ({ page, bff }) => {
  bff.pushUnavailable = true;
  await page.goto("/"); await login(page); await addRecord(page);
  const stored = await storedPartition(page, users.Alice.id);
  const entry = Object.values(stored.records)[0];
  bff.pullRows = [{ seq: 1, remote: { kind: "entry", resourceId: entry.id, version: 1, snapshot: entry, tombstone: false } }];
  const started = deferred(); const release = deferred(); let held = false;
  bff.beforeReply = async call => {
    if (call.path === "/api/sync/pull" && call.userId === users.Alice.id && !held) { held = true; started.resolve(); await release.promise; }
  };
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "立即同步", exact: true }).click();
  try {
    await started.promise;
    await logout(page);
    bff.pullRows = [];
    await login(page, "Bob");
    release.resolve();
    await page.getByRole("button", { name: "今天", exact: true }).click();
    await expect(page.locator(".entry")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(note);
    const bob = await storedPartition(page, users.Bob.id);
    expect(Object.values(bob?.records ?? {})).toEqual([]);
    await page.reload();
    await expect(page.getByRole("heading", { name: "肠记", exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(note);
  } finally { release.resolve(); }
});
