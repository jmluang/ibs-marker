import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { LAN_HOST, LAN_PORT, startLanPreview } from "./preview-lan.mjs";

// Isolated synthetic acceptance only; never read credentials or existing browser data.
const evidence = resolve(process.argv[2] ?? "test-results/lan");
await mkdir(evidence, { recursive: true });
let server;
let browser;
const results = { http: [], browser: null };
function probe(path, localAddress, headers = {}, method = "GET") {
  return new Promise((fulfill, reject) => {
    const req = request({ agent: false, host: LAN_HOST, port: LAN_PORT, path, localAddress, headers, method }, (res) => {
      res.resume();
      res.on("end", () => fulfill(res.statusCode));
    });
    req.setTimeout(5000, () => req.destroy(new Error("Request timeout")));
    req.on("error", reject);
    req.end();
  });
}
try {
  server = await startLanPreview();
  assert.equal(server.httpServer.address().address, LAN_HOST);
  assert.equal(server.httpServer.address().port, LAN_PORT);
  await assert.rejects(startLanPreview(), /already in use/);
  for (const source of ["127.0.0.1", "100.109.89.118"]) {
  for (const path of ["/", "/assets/nonexistent.js", "/sw.js", "/manifest.webmanifest", "/history"]) {
    for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
      const status = await probe(path, source, { Host: LAN_HOST, "X-Forwarded-For": "10.21.1.2", Forwarded: "for=10.21.1.2", "X-Real-IP": "10.21.1.2" }, method);
      assert.equal(status, 403);
      results.http.push({ path, method, source, spoofedHeaders: true, status });
    }
  }
  }
  assert.equal(await probe("/", LAN_HOST), 200);
  results.http.push({ path: "/", source: LAN_HOST, status: 200 });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-proxy-server"] });
  const context = await browser.newContext();
  await context.route("**/*", (route) => new URL(route.request().url()).hostname === LAN_HOST ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://${LAN_HOST}:${LAN_PORT}`);
  const capabilities = await page.evaluate(() => ({ secureContext: isSecureContext, randomUUID: typeof crypto.randomUUID, getRandomValues: typeof crypto.getRandomValues }));
  assert.deepEqual(capabilities, { secureContext: false, randomUUID: "undefined", getRandomValues: "function" });
  async function enterLocal() {
    const button = page.getByRole("button", { name: /明确进入仅本机模式|进入本机记录/ });
    if (await button.count()) await button.click();
    await expect(page.getByRole("button", { name: "补记一次", exact: true })).toBeVisible();
  }
  await enterLocal();
  await page.getByRole("button", { name: "补记一次", exact: true }).click();
  await page.getByRole("button", { name: "有排出", exact: true }).click();
  await page.getByRole("button", { name: "4 光滑", exact: true }).click();
  await page.getByRole("button", { name: "保存如厕记录", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(1);
  await page.getByText("其他记录 ＋").click();
  await page.getByRole("button", { name: "记录独立症状", exact: true }).click();
  await page.getByRole("button", { name: "保存症状记录", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(2);
  await page.getByText("其他记录 ＋").click();
  await page.getByRole("button", { name: "记录加餐 / 饮料", exact: true }).click();
  await page.getByLabel("吃了什么、喝了什么？").fill("合成 LAN 测试，不是真实健康资料");
  await page.getByRole("button", { name: "保存饮食记录", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(3);
  await page.getByRole("button", { name: "开始如厕 ↗", exact: true }).click();
  await expect(page.getByRole("button", { name: "结束如厕", exact: true })).toBeVisible();
  await page.reload();
  const localButton = page.getByRole("button", { name: /明确进入仅本机模式|进入本机记录/ });
  if (await localButton.count()) await localButton.click();
  await page.getByRole("button", { name: "结束如厕", exact: true }).click();
  await page.getByRole("button", { name: "没有排出", exact: true }).click();
  await page.getByRole("button", { name: "保存如厕记录", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(4);
  await page.reload();
  await enterLocal();
  await expect(page.locator(".entry")).toHaveCount(4);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(evidence, "http-lan-records.png"), fullPage: true });
  results.browser = { capabilities, syntheticPersistedRecords: 4, timerAcrossReload: true, pageErrors: errors, externalRequestsBlocked: true };
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (browser) await browser.close();
  if (server) {
    await new Promise((fulfill, reject) => {
      server.httpServer.close((error) => error ? reject(error) : fulfill());
      server.httpServer.closeAllConnections();
    });
  }
  await writeFile(resolve(evidence, "lan-acceptance.json"), JSON.stringify(results, null, 2));
}
