import type { Page } from "@playwright/test";
import { test, expect, password, logout, deferred } from "./bff.fixture";

async function registration(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "还没有账号？去注册", exact: true }).click();
  await page.getByLabel("用户名", { exact: true }).fill("Alice");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByPlaceholder("输入邀请码").fill("fixture-only");
}
const submit = (page: Page) => page.getByRole("button", { name: "创建账号", exact: true }).click();
async function retained(page: Page, username = "Alice", value = password, invite = "fixture-only") {
  await expect(page.getByLabel("用户名", { exact: true })).toHaveValue(username);
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue(value);
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByPlaceholder("输入邀请码")).toHaveValue(invite);
  await expect(page.getByPlaceholder("输入邀请码")).toHaveAttribute("type", "password");
}
test.afterEach(async ({ page }, testInfo) => {
  await testInfo.attach("form-state", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});
test("restricted hash/history routes retain backend login gate and no guest bypass", async ({ page }) => {
  await page.goto("/#history");
  await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /本机|访客|Guest/ })).toHaveCount(0);
  for (const route of ["#stats", "#new/meal/lunch", "#settings"]) {
    await page.evaluate(hash => { location.hash = hash; }, route);
    await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
  }
  await page.goBack();
  await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
});
test("one primary action, real computed CSS, exact registration and same-origin BFF auto-login", async ({ page, bff }) => {
  await registration(page);
  await expect(page.locator("input")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "创建账号", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "创建账号", exact: true })).toHaveCSS("background-color", "rgb(65, 108, 119)");
  await expect(page.getByRole("button", { name: "创建账号", exact: true })).toHaveCSS("color", "rgb(255, 255, 255)");
  const modeSwitch = page.getByRole("button", { name: "已有账号？去登录", exact: true });
  await expect(modeSwitch).toHaveCSS("border-top-width", "0px");
  await expect(modeSwitch).toHaveCSS("padding-left", "0px");
  await expect(modeSwitch).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.locator("body")).not.toContainText(/邮箱|验证码|找管理员|示例|预期|控制台|ibs-marker.invalid/);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/register");
  await submit(page);
  expect((await response).status()).toBe(201);
  await expect(page.getByRole("heading", { name: "肠记", exact: true })).toBeVisible();
  const calls = bff.calls.filter(call => ["/api/register", "/api/auth/prepare", "/api/auth/login"].includes(call.path));
  expect(calls.map(call => call.path)).toEqual(["/api/register", "/api/auth/prepare", "/api/auth/login"]);
  expect(calls[0].body).toEqual({ username: "Alice", password, inviteCode: "fixture-only" });
  expect(calls[1].body).toEqual({ authRevision: expect.any(String) });
  expect(calls[2].body).toEqual({ username: "Alice", password, authRevision: expect.any(String), attemptId: expect.any(String) });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByText("云账号：Alice", { exact: true })).toBeVisible();
  await logout(page);
  await page.reload();
  await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
});
test("invalid username, short password and empty invite: correct validation, zero action HTTP", async ({ page, bff }) => {
  await registration(page);
  const initialCount = bff.calls.length;
  await page.getByLabel("用户名", { exact: true }).fill(" Alice");
  await submit(page);
  await expect(page.getByRole("alert")).toHaveText("请输入有效用户名。");
  await retained(page, " Alice");
  await expect(page.getByPlaceholder("输入邀请码")).not.toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("用户名", { exact: true }).fill("Alice");
  await page.getByLabel("密码", { exact: true }).fill("123456");
  await submit(page);
  await expect(page.getByRole("alert")).toContainText("密码至少需要 8");
  await retained(page, "Alice", "123456");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByPlaceholder("输入邀请码").fill("");
  await submit(page);
  await expect(page.getByRole("alert")).toHaveText("输入邀请码");
  expect(bff.calls.slice(initialCount)).toEqual([]);
});
test("wrong invite is specific, masked and retained", async ({ page, bff }, testInfo) => {
  bff.registerStatus = 403;
  bff.registerCode = "INVITE_INVALID";
  await registration(page); await submit(page);
  await expect(page.getByRole("alert")).toHaveText("邀请码不正确");
  await expect(page.getByPlaceholder("输入邀请码")).toHaveAttribute("aria-invalid", "true");
  await retained(page);
  await testInfo.attach("invite-error-retained-input", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await page.getByRole("button", { name: "已有账号？去登录" }).click();
  await expect(page.getByLabel("用户名", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue("");
});
test("duplicate username and rate limit do not mark invite invalid", async ({ page, bff }) => {
  for (const [code, status, message] of [["USERNAME_TAKEN", 409, "用户名已存在，请登录。"], ["RATE_LIMITED", 429, "请求过于频繁，请稍后再试。"]] as const) {
    bff.registerCode = code; bff.registerStatus = status;
    await registration(page); await submit(page);
    await expect(page.getByRole("alert")).toHaveText(message);
    await retained(page);
    await expect(page.getByPlaceholder("输入邀请码")).not.toHaveAttribute("aria-invalid", "true");
  }
});
test("network, unknown provider/server and handler failures stay safe without duplicate relabeling", async ({ page, bff }) => {
  await page.route("**/api/register", r => r.abort("failed"));
  await registration(page); await submit(page);
  await expect(page.getByRole("alert")).toHaveText("注册请求失败，请检查网络。");
  await retained(page);
  await page.unroute("**/api/register");
  bff.registerStatus = 503; bff.registerCode = "provider-secret";
  await submit(page);
  await expect(page.getByRole("alert")).toHaveText("暂时无法注册，请稍后重试。");
  await retained(page);
  await expect(page.getByRole("alert")).not.toContainText(/用户名已存在|provider-secret/);
  await page.evaluate(async modulePath => {
    const { CloudController } = await import(/* @vite-ignore */ modulePath);
    CloudController.prototype.register = async () => { throw new Error("provider-secret"); };
  }, "/src/cloud/bootstrap.ts");
  await submit(page);
  await expect(page.getByRole("alert")).toHaveText("操作失败，请重试。");
  await retained(page);
  await expect(page.getByPlaceholder("输入邀请码")).not.toHaveAttribute("aria-invalid", "true");
});
test("account creation followed by failed BFF auto-login switches to login", async ({ page, bff }) => {
  bff.loginFailure = true;
  await registration(page); await submit(page);
  await expect(page.getByRole("alert")).toHaveText("账号已创建，请登录");
  await expect(page.getByPlaceholder("输入邀请码")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue("");
  await page.getByLabel("用户名", { exact: true }).fill("Alice");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("登录失败，请检查用户名和密码。");
  await expect(page.getByLabel("用户名", { exact: true })).toHaveValue("Alice");
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue(password);
});
for (const stage of ["registration", "bff-login"] as const) {
  test(`changing route cancels late ${stage} completion and refresh stays gated`, async ({ page, bff }) => {
    const gate = deferred(); const started = deferred();
    bff.beforeCommit = async call => { if (stage === "bff-login" && call.path === "/api/auth/login") { started.resolve(); await gate.promise; } };
    if (stage === "registration") await page.route("**/api/register", async route => { started.resolve(); await gate.promise; await route.fallback(); });
    await registration(page); await submit(page); await started.promise;
    await page.evaluate(() => { location.hash = "#history"; });
    await expect(page.getByRole("button", { name: "创建账号", exact: true })).toBeEnabled();
    gate.resolve();
    if (stage === "bff-login") {
      await expect.poll(async () => (await bff.current())?.user ?? null).toBeNull();
    }
    await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
    if (stage === "registration") expect(bff.calls.some(call => call.path === "/api/auth/login")).toBe(false);
    await page.reload();
    await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
  });
}
test("only HTTP 201 may trigger automatic login", async ({ page, bff }) => {
  for (const status of [200, 202, 204]) {
    bff.registerStatus = status;
    await registration(page); await submit(page);
    await expect(page.getByRole("alert")).toHaveText("注册失败，请重试。");
    await retained(page);
    expect(bff.calls.some(call => call.path === "/api/auth/login" || call.path === "/api/auth/prepare")).toBe(false);
  }
});
