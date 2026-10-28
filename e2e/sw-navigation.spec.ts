import { test, expect } from "@playwright/test";
// Native SW + isolated synthetic HTTP shell. Not production cold-offline acceptance.
test("native SW: external link, query refresh and document failures use only known shell", async ({ page, context, request }, testInfo) => {
  await request.put("/__fixture/state", { data: { fault: "none" } });
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js?build=native-fixture");
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  });
  for (const fault of ["forbidden", "unavailable", "non-html"]) {
    await request.put("/__fixture/state", { data: { fault } });
    for (const path of ["/", "/?x=1", "/index.html?x=1"]) {
      const response = await page.goto(path);
      expect(response?.fromServiceWorker()).toBe(true);
      await expect(page.getByRole("heading", { name: "Native SW fixture shell" })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("heading", { name: "Native SW fixture shell" })).toBeVisible();
    }
  }
  // A genuinely different loopback origin links into the already controlled app.
  await page.goto("http://localhost:15007/external");
  await page.getByRole("link", { name: "Open known app" }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:15007\/\?external=1/);
  await expect(page.getByRole("heading", { name: "Native SW fixture shell" })).toBeVisible();
  const api = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session");
    return { status: response.status, body: await response.json() };
  });
  expect(api).toEqual({ status: 403, body: { code: "SYNTHETIC_BOUNDARY_DENIED" } });
  for (const path of ["/private", "/unknown?x=1", "/api/auth/session", "/auth/callback", "/rest/v1/data", "/sw.js?build=wrong"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(403);
    expect(response?.fromServiceWorker()).toBe(false);
    await expect(page.getByRole("heading", { name: "Native SW fixture shell" })).toHaveCount(0);
  }
  await page.goto("/?offline=prepare");
  const cache = await page.evaluate(async () => {
    const keys = await caches.keys();
    const shell = await caches.open("ibs-marker-shell-native-fixture");
    return { keys, urls: (await shell.keys()).map(request => new URL(request.url).pathname), body: await (await shell.match("/index.html"))!.text() };
  });
  expect(cache.urls).toEqual(["/index.html"]);
  expect(cache.body).not.toContain("SYNTHETIC_");
  await context.setOffline(true);
  await page.goto("/index.html?offline=1");
  await expect(page.getByRole("heading", { name: "Native SW fixture shell" })).toBeVisible();
  expect(await page.evaluate(async () => { try { await fetch("/api/auth/session"); return false; } catch { return true; } })).toBe(true);
  await context.setOffline(false);
  await testInfo.attach("native-sw-boundary", { body: JSON.stringify({ syntheticShell: true, productionServer: false, cache }), contentType: "application/json" });
});
