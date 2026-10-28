import type { Page } from "@playwright/test";
import { test, expect } from "./bff.fixture";
async function expectGate(page: Page) {
  await expect(page.getByRole("heading", { name: "记录，慢慢了解自己。" })).toBeVisible();
  await expect(page.getByRole("region", { name: "云同步设置" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "肠记", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /本机|访客|游客/ })).toHaveCount(0);
  await expect(page.locator(".entry, .metrics, .completeness")).toHaveCount(0);
  await expect(page.getByRole("navigation")).toHaveCount(0);
}
test("backend session outage fails closed without provider config or guest fallback", async ({ page, bff }) => {
  bff.unavailable = true;
  await page.goto("/"); await expectGate(page);
  await expect(page.getByRole("alert")).toBeVisible();
  await page.reload(); await expectGate(page);
  expect(bff.calls.some(call => call.path === "/api/auth/session")).toBe(true);
  expect(bff.calls.every(call => call.status === 503)).toBe(true);
});
test("hash, history and refresh cannot bypass an unavailable same-origin backend", async ({ page, bff }) => {
  bff.unavailable = true;
  await page.goto("/#history"); await expectGate(page);
  for (const hash of ["settings", "stats", "new/toilet", "timer", "edit/synthetic-record"]) {
    await page.evaluate(value => { window.location.hash = value; }, hash); await expectGate(page);
  }
  await page.goBack(); await expectGate(page);
  await page.goForward(); await expectGate(page);
  await page.evaluate(() => { history.pushState({}, "", "/history#settings"); dispatchEvent(new PopStateEvent("popstate")); });
  await expectGate(page); await page.reload(); await expectGate(page);
});
