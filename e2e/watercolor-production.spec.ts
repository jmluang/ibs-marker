import { test, expect, type Page } from "@playwright/test";
import type { NamespaceData } from "../src/domain/types";

/**
 * Parent-owned watercolor-production.fixture.config.ts must start the REAL
 * createApplication/start-server Node candidate against the final built dist,
 * using an isolated synthetic SERVER-side provider transport/session store.
 * No Playwright API fulfill, source-module import, local-mode bypass or HTML shell.
 * The parent verifies native Node startup with watercolor-native-fixture-check.mjs;
 * this spec asserts the configured Node launcher, runtime fixture control and
 * actual final manifest/SW/assets. No metadata assertion substitutes for HTTP.
 * Synthetic login contract is shared with existing bff.fixture.ts:
 * Alice / " raw password ". Never substitute a real account or read .env.
 */
test.use({ serviceWorkers: "allow" });
const note = "合成生产验收 · 不是真实健康资料";
const aliceNamespace = "user:11111111-1111-4111-8111-111111111111";
type Partition = { namespace: string; data: NamespaceData };
async function allPartitions(page: Page): Promise<Partition[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open("ibs-marker-v1");
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      return await new Promise<Partition[]>((resolve, reject) => {
        const transaction = db.transaction("namespaces", "readonly");
        const request = transaction.objectStore("namespaces").openCursor();
        const matches: Partition[] = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          matches.push({ namespace: String(cursor.key), data: cursor.value });
          cursor.continue();
        };
        transaction.oncomplete = () => resolve(matches);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { db.close(); }
  });
}
async function partition(page: Page): Promise<Partition> {
  const rows = await allPartitions(page);
  expect(rows.map(row => row.namespace), "Only Alice's actual persisted partition may exist").toEqual([aliceNamespace]);
  return rows[0];
}

test("最终Node候选：原生版本SW冷precache字体、私有登录、离线页面/草稿/编辑/queue与同源边界", async ({ page, context, baseURL, request }, info) => {
  test.setTimeout(120_000);
  const servers = Array.isArray(info.config.webServer) ? info.config.webServer : info.config.webServer ? [info.config.webServer] : [];
  const provenance = { commands: servers.map(server => server.command), metadata: info.config.metadata.watercolorCandidate };
  expect(provenance.commands.join("\n"), "Use real Node candidate fixture, not Vite preview/syntheticShell").toMatch(/watercolor-production\.server\.mjs|scripts\/start-server\.mjs/);
  expect(baseURL).toBeTruthy();
  const origin = new URL(baseURL!).origin;
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(origin).hostname);
  const foreign: string[] = [], vendor: string[] = [], errors: string[] = [], traffic: { url: string; method: string; sw: boolean }[] = [];
  context.on("request", req => {
    const url = new URL(req.url());
    if (!/^https?:$/.test(url.protocol)) return;
    traffic.push({ url: req.url(), method: req.method(), sw: !!req.serviceWorker() });
    if (url.origin !== origin) foreign.push(req.url());
    if (/supabase|googleapis|gstatic|fonts\.google|\/auth\/v1|\/rest\/v1/i.test(req.url()) || req.headers().apikey || req.headers().authorization) vendor.push(req.url());
  });
  context.on("page", p => p.on("pageerror", error => errors.push(error.message)));
  page.on("pageerror", error => errors.push(error.message));
  // This firewall continues same-origin traffic UNMODIFIED; it never fulfills API.
  // context request events also cover SW-owned HTTP requests above.
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort("blockedbyclient"));
  await context.routeWebSocket(/.*/, socket => {
    const url = new URL(socket.url());
    if (url.host !== new URL(origin).host) foreign.push(socket.url());
    socket.close();
  });
  expect((await request.post("/__fixture/reset", { data: {} })).status()).toBe(200);
  const fixtureState = await request.get("/__fixture/state");
  expect(fixtureState.status()).toBe(200);
  const syntheticState = await fixtureState.json();
  expect(syntheticState).toBeTruthy();
  expect((await request.get("/readyz")).status()).toBe(200);
  const manifestResponse = await request.get("/asset-manifest.json");
  expect(manifestResponse.status()).toBe(200);
  const manifest = await manifestResponse.json() as { buildId: string; assets: string[] };
  expect(manifest.buildId).toBeTruthy();
  expect(manifest.buildId).not.toBe("native-fixture");
  expect(manifest.assets).toContain("/index.html");
  const fonts = manifest.assets.filter(path => /\.woff2$/.test(path));
  expect(fonts.length).toBeGreaterThan(0);
  // APIRequestContext does not warm the browser HTTP/font cache.
  for (const font of fonts) {
    const response = await request.get(font);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/^font\/woff2(?:;|$)/);
  }
  for (const asset of manifest.assets) { expect(asset).toMatch(/^\/(?!\/)/); expect(asset).not.toMatch(/^\/(api|auth|rest)\//); }
  const first = await page.goto("/");
  expect(first?.status()).toBe(200);
  expect(first?.headers()["content-type"]).toMatch(/^text\/html/);
  await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "进入本机记录", exact: true })).toHaveCount(0);
  // No second online navigation and no manual font warmup before this snapshot.
  const cold = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    const active = registration.active!;
    const build = new URL(active.scriptURL).searchParams.get("build");
    const key = "ibs-marker-shell-" + build;
    const cache = await caches.open(key);
    const cached = [];
    for (const request of await cache.keys()) {
      const response = (await cache.match(request))!;
      cached.push({ path: new URL(request.url).pathname, status: response.status, bytes: (await response.clone().arrayBuffer()).byteLength });
    }
    return { scriptURL: active.scriptURL, build, key, keys: await caches.keys(), cached };
  });
  expect(cold.build).toBe(manifest.buildId);
  expect(cold.scriptURL).toBe(`${origin}/sw.js?build=${encodeURIComponent(manifest.buildId)}`);
  for (const asset of manifest.assets) {
    const cached = cold.cached.find(row => row.path === asset);
    expect(cached, `cold install precaches ${asset}`).toBeTruthy();
    expect(cached!.status).toBe(200); expect(cached!.bytes).toBeGreaterThan(0);
  }
  expect(cold.cached.some(row => /^\/(api|auth|rest)\//.test(row.path))).toBe(false);
  const sw = await request.get(new URL(cold.scriptURL).pathname + new URL(cold.scriptURL).search);
  expect(sw.status()).toBe(200); expect(sw.headers()["content-type"]).toMatch(/javascript/);
  // Cold offline fonts must work BEFORE an authenticated online page warms assets.
  await context.setOffline(true);
  const coldOffline = await page.goto("/index.html?watercolor-cold=1");
  expect(coldOffline?.fromServiceWorker()).toBe(true);
  await expect(page.getByText("账号连接暂不可用，请重试连接。", { exact: true })).toBeVisible();
  await expect(page.getByText(/无需重新输入密码/)).toBeVisible();
  await expect(page.getByRole("button", { name: "重试连接", exact: true })).toBeVisible();
  await expect(page.getByLabel("用户名", { exact: true })).toHaveCount(0);
  for (const id of ["watercolor-home", "watercolor-history", "watercolor-stats", "watercolor-settings"]) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
  await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(0);
  const offlineFont = await page.evaluate(async () => {
    const faces = await document.fonts.load('16px "Xiaolai UI"');
    await document.fonts.ready;
    return { loaded: faces.some(face => face.status === "loaded" && face.family.includes("Xiaolai UI")) };
  });
  // Cold cache proves the actual face loads, not an unrelated welcome h1 style.
  expect(offlineFont.loaded).toBe(true);
  await context.setOffline(false);
  await page.reload();
  await page.getByLabel("用户名", { exact: true }).fill("Alice");
  await page.getByLabel("密码", { exact: true }).fill(" raw password ");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByTestId("watercolor-home")).toBeVisible();
  const identity = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session");
    const body = await response.json();
    return { status: response.status, user: body.user };
  });
  expect(identity).toEqual({ status: 200, user: { id: aliceNamespace.slice(5), displayName: "Alice" } });
  // Adapter reads are lazy: login need not write an empty namespace. Inspect
  // every actual row (including guest/other identities), never fabricate data.
  const initial = await allPartitions(page);
  expect(initial.length).toBeLessThanOrEqual(1);
  for (const row of initial) {
    expect(row.namespace).toBe(aliceNamespace);
    expect(Object.values(row.data.records)).toHaveLength(0);
  }
  await context.setOffline(true);
  await page.getByRole("button", { name: /^补记(?:一次|如厕)/ }).click();
  await page.getByLabel("备注（可选）").fill(note);
  await expect(page.getByRole("status")).toContainText("草稿已保存在本机");
  // The first real write must now have created Alice's durable partition.
  expect(Object.values((await partition(page)).data.records)).toHaveLength(0);
  const draftResponse = await page.reload();
  expect(draftResponse?.fromServiceWorker()).toBe(true);
  await expect(page.getByLabel("备注（可选）")).toHaveValue(note);
  await page.getByRole("button", { name: "保存如厕记录", exact: true }).click();
  await expect(page.getByTestId("watercolor-home")).toBeVisible();
  let saved = await partition(page);
  const records = Object.values(saved.data.records);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ note, result: "unsure", discomfort: { status: "unknown" }, estimatedTime: false });
  expect(saved.data.outbox).toEqual(expect.arrayContaining([expect.objectContaining({ resourceId: records[0].id, kind: "entry", tombstone: false })]));
  await page.getByRole("button", { name: /开始如厕|开始计时/ }).click();
  await page.getByRole("button", { name: /返回/ }).first().click();
  const timer = (await partition(page)).data.timer;
  expect(timer).not.toBeNull();
  for (const [name, id] of [["历史", "watercolor-history"], ["统计", "watercolor-stats"], ["设置", "watercolor-settings"], ["今天", "watercolor-home"]]) {
    await page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
    await expect(page.getByTestId(id)).toBeVisible();
    const heading = await page.getByTestId(id).locator("h1").evaluate(el => {
      const css = getComputedStyle(el);
      return { family: css.fontFamily, weight: css.fontWeight };
    });
    expect(heading.family, `${name} main-page heading`).toContain("Xiaolai UI");
    expect(heading.weight, `${name} main-page heading`).toBe("400");
    expect((await partition(page)).data.timer).toEqual(timer);
  }
  await page.locator(".entry").filter({ hasText: note }).click();
  await page.getByLabel("备注（可选）").fill(note + " · 离线编辑");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  // save() awaits the draft queue, entry transaction and draft removal before
  // onClose navigates home; reloading sooner can interrupt the real commit.
  await expect(page.getByTestId("watercolor-home")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("watercolor-home")).toBeVisible();
  await expect(page.locator(".entry")).toContainText(note + " · 离线编辑");
  saved = await partition(page);
  expect(saved.data.records[records[0].id].note).toBe(note + " · 离线编辑");
  expect(saved.data.timer).toEqual(timer);
  expect(saved.data.outbox.filter(op => op.resourceId === records[0].id)).toHaveLength(1);
  expect(saved.data.outbox.find(op => op.resourceId === records[0].id)?.snapshot).toMatchObject({ note: note + " · 离线编辑" });
  const cachedAfter = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const key of await caches.keys()) for (const request of await (await caches.open(key)).keys()) urls.push(request.url);
    return urls;
  });
  expect(cachedAfter.every(url => new URL(url).origin === origin && !/^\/(api|auth|rest)\//.test(new URL(url).pathname))).toBe(true);
  // Inspect final emitted JS/CSS, not source strings or a synthetic shell.
  for (const asset of manifest.assets.filter(path => /\.(js|css)$/.test(path))) {
    const response = await request.get(asset); expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text, asset).not.toMatch(/https?:\/\/[^\s"'`<>]*(?:supabase\.(?:co|com)|googleapis\.com|gstatic\.com)|sb_publishable_|sb_secret_|eyJhbGciOi/);
    expect(text, asset).not.toContain("@supabase/supabase-js");
  }
  expect(traffic.some(row => row.url.endsWith("/api/auth/login"))).toBe(true);
  expect(traffic.some(row => /\/src\/|\/@vite\//.test(new URL(row.url).pathname))).toBe(false);
  expect(foreign).toEqual([]); expect(vendor).toEqual([]); expect(errors).toEqual([]);
  await info.attach("actual-node-cold-sw-offline", { body: JSON.stringify({ syntheticBackend: true, realCloudAcceptance: false, provenance, syntheticState, manifest, cold, offlineFont, identity, initial, namespace: saved.namespace, records: Object.values(saved.data.records), outbox: saved.data.outbox, timer, foreign, vendor, errors, traffic }, null, 2), contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("production-candidate-offline.png"), fullPage: true });
  await context.setOffline(false);
});
