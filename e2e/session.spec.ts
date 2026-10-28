import { test, expect, deferred, login, logout, users, password } from "./bff.fixture";

test("initial same-cookie two-tab bootstrap serializes handshake through body and confirmation", async ({ page, context, bff }) => {
  const started = deferred(); const release = deferred();
  const confirming = deferred(); const confirmRelease = deferred();
  let owner: number | undefined;
  bff.beforeReply = async call => {
    if (call.path === "/api/auth/bootstrap") { owner = call.tab; started.resolve(); await release.promise; }
    if (call.path === "/api/auth/session" && call.status === 200 && call.tab === owner) {
      confirming.resolve(); await confirmRelease.promise;
    }
  };
  const firstNavigation = page.goto("/");
  const second = await context.newPage();
  try {
    await started.promise;
    const secondNavigation = second.goto("/");
    const waitingForLock = () => second.evaluate(async () => {
      const locks = await navigator.locks.query();
      return locks.pending?.some(lock => lock.name === "ibs-marker-bff-bootstrap") ?? false;
    }).catch(() => false);
    await expect.poll(waitingForLock).toBe(true);
    // Entire handshake is serialized: no second tab probe may pass the lock
    // while bootstrap's complete response body or confirmation is pending.
    expect(bff.calls.map(call => [call.path, call.status])).toEqual([
      ["/api/auth/session", 428], ["/api/auth/bootstrap", 200],
    ]);
    release.resolve();
    await confirming.promise;
    await expect.poll(waitingForLock).toBe(true);
    expect(bff.calls.filter(call => call.path === "/api/auth/session" && call.status === 200).map(call => call.tab)).toEqual([owner]);
    confirmRelease.resolve();
    await Promise.all([firstNavigation, secondNavigation]);
    await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
    await expect(second.getByLabel("用户名", { exact: true })).toBeVisible();
    expect(bff.calls.filter(call => call.path === "/api/auth/bootstrap")).toHaveLength(2);
    expect(bff.sessions.size).toBe(1);
    const confirmations = bff.calls.filter(call => call.path === "/api/auth/session" && call.status === 200);
    // First confirmation, then second tab's healthy probe + confirmation.
    expect(confirmations).toHaveLength(3);
    expect(confirmations[0].tab).not.toBe(confirmations[1].tab);
    expect(confirmations[1].tab).toBe(confirmations[2].tab);
    const cookies = await context.cookies(bff.origin);
    const stable = cookies.find(cookie => cookie.name === bff.cookieName)!;
    expect(stable.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain(stable.value);
    // Revalidating a tab can intentionally lock other visible identities; login
    // remains explicit and server authorization is always the cookie revision.
    await login(page);
    await second.reload();
    await expect(second.getByRole("heading", { name: "肠记", exact: true })).toBeVisible();
    await second.getByRole("button", { name: "设置", exact: true }).click();
    await expect(second.getByText("云账号：Alice", { exact: true })).toBeVisible();
    expect((await context.cookies(bff.origin)).find(cookie => cookie.name === bff.cookieName)?.value).toBe(stable.value);
  } finally { release.resolve(); confirmRelease.resolve(); }
});

test("without navigator.locks a new browser context refuses bootstrap", async ({ page, context, bff }) => {
  await context.addInitScript(() => { Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }); });
  await page.goto("/");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /本机|访客|Guest/ })).toHaveCount(0);
  await expect(page.getByRole("alert")).toBeVisible();
  expect(bff.calls.filter(call => call.path === "/api/auth/bootstrap")).toHaveLength(0);
  expect(await context.cookies(bff.origin)).toEqual([]);
});

for (const phase of ["commit", "successful-body"] as const) {
test(`delayed A login ${phase} cannot overwrite newer B; both tabs refresh as B`, async ({ page, context, bff }) => {
  const started = deferred(); const release = deferred();
  const hold = async (call: import("./bff.fixture").RequestRecord) => {
    if (call.path === "/api/auth/login" && call.body?.username === "Alice") { started.resolve(); await release.promise; }
  };
  if (phase === "commit") bff.beforeCommit = hold;
  else bff.beforeReply = hold;
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("Alice");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  try {
    await started.promise;
    const second = await context.newPage();
    await second.goto("/");
    await login(second, "Bob");
    expect((await bff.current())?.user).toEqual(users.Bob);
    release.resolve();
    await expect.poll(() => bff.calls.find(call => call.path === "/api/auth/login" && call.body?.username === "Alice")?.status).toBe(phase === "commit" ? 409 : 200);
    if (phase === "successful-body") {
      await expect.poll(() => bff.calls.some(call => call.path === "/api/auth/logout" && call.status === 409)).toBe(true);
      const metadata = await page.evaluate(() => JSON.parse(localStorage.getItem("ibs-marker-bff-auth-state")!));
      expect(metadata).toMatchObject({ user: users.Bob, locked: false });
    }
    expect((await bff.current())?.user).toEqual(users.Bob);
    for (const tab of [page, second]) {
      // Verify the just-refreshed tab; another tab may intentionally lock stale
      // UI after metadata revalidation rather than silently switch identities.
      await tab.reload();
      await expect(tab.getByRole("heading", { name: "肠记", exact: true })).toBeVisible();
      await tab.getByRole("button", { name: "设置", exact: true }).click();
      await expect(tab.getByText("云账号：Bob", { exact: true })).toBeVisible();
    }
  } finally { release.resolve(); }
});
}

test("delayed old logout A cannot clear B or rotate the stable cookie", async ({ page, context, bff }) => {
  await page.goto("/"); await login(page);
  const sid = (await context.cookies(bff.origin)).find(cookie => cookie.name === bff.cookieName)?.value;
  const started = deferred(); const release = deferred(); let holdFirst = true;
  bff.beforeCommit = async call => {
    if (call.path === "/api/auth/logout" && holdFirst) { holdFirst = false; started.resolve(); await release.promise; }
  };
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "退出本设备" }).click();
  try {
    await started.promise;
    await expect(page.getByRole("navigation")).toHaveCount(0);
    const second = await context.newPage();
    await second.goto("/");
    // The shared durable logout marker must gate this tab even though the old
    // server logout is still pending. Explicit B login can supersede it safely.
    await expect(second.getByLabel("用户名", { exact: true })).toBeVisible();
    await expect(second.getByRole("navigation")).toHaveCount(0);
    await login(second, "Bob");
    const revisionB = (await bff.current())!.authRevision;
    release.resolve();
    await expect.poll(() => bff.calls.find(call => call.path === "/api/auth/logout")?.status).toBe(409);
    expect(await bff.current()).toMatchObject({ user: users.Bob, authRevision: revisionB });
    expect((await context.cookies(bff.origin)).find(cookie => cookie.name === bff.cookieName)?.value).toBe(sid);
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByText("云账号：Bob", { exact: true })).toBeVisible();
  } finally { release.resolve(); }
});

test("refresh restores only BFF metadata, never JS credentials or a local guest partition", async ({ page, context, bff }) => {
  await page.goto("/"); await login(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "肠记", exact: true })).toBeVisible();
  const storage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  const cookies = await context.cookies(bff.origin);
  expect(JSON.stringify(storage)).not.toMatch(/access_token|refresh_token|authorization|bearer|sb-.*auth-token/i);
  const sid = cookies.find(cookie => cookie.name === bff.cookieName)!.value;
  expect(JSON.stringify(storage)).not.toContain(sid);
  const pulls = bff.calls.filter(call => call.path === "/api/sync/pull");
  await expect.poll(() => bff.calls.filter(call => call.path === "/api/sync/pull").length).toBeGreaterThan(0);
  for (const pull of pulls) expect(pull.revision).toEqual(expect.any(String));
});
