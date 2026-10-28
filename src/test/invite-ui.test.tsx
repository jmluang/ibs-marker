import { it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CloudPanel } from "../cloud/CloudPanel";
import { deferred, harness, json, tick } from "./bff-fixture";
async function setup(request?: typeof fetch) {
  const h = harness();
  const c = await h.boot({ registerFetch: request });
  return { ...h, c };
}
it.each([
  ["INVITE_REQUIRED", "输入邀请码", "invite"],
  ["INVITE_INVALID", "邀请码不正确", "invite"],
  ["USERNAME_TAKEN", "用户名已存在，请登录。", "username"],
  [
    "INVALID_PASSWORD",
    "密码至少需要 8 个字符，且不能超过 1024 字节。",
    "password",
  ],
  ["RATE_LIMITED", "请求过于频繁，请稍后再试。", undefined],
  ["REGISTRATION_UNAVAILABLE", "暂时无法注册，请稍后重试。", undefined],
])(
  "maps safe registration code %s without provider text",
  async (code, message, field) => {
    const { c } = await setup(async () =>
      json({ code, error: "provider-secret" }, 400),
    );
    expect(await c.register("Alice", "raw-password", "wrong")).toEqual({
      registered: false,
    });
    expect(c.getSnapshot()).toMatchObject({
      error: message,
      errorField: field,
      busy: false,
    });
  },
);
it("short/oversized passwords, invalid usernames and blank invite send no registration or login", async () => {
  const request = vi.fn();
  const { c, fetcher } = await setup(request);
  fetcher.mockClear();
  for (const password of ["123456", "密".repeat(400)]) {
    await c.register("Alice", password, "wrong");
    expect(c.getSnapshot().error).toContain("密码至少需要 8");
  }
  await c.register("Alice", "raw-password", "");
  expect(c.getSnapshot().error).toBe("输入邀请码");
  await c.register(" Alice", "raw-password", "wrong");
  expect(c.getSnapshot().errorField).toBe("username");
  expect(request).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it("network failures are not mislabeled as invite failures", async () => {
  const { c } = await setup(async () => {
    throw new TypeError("provider-secret");
  });
  expect(await c.register("Alice", "raw-password", "wrong")).toEqual({
    registered: false,
  });
  expect(c.getSnapshot().error).toBe("注册请求失败，请检查网络。");
});
it.each(["reject", "missing-user"])(
  "created account with %s auto-login reports creation and routes to login",
  async (mode) => {
    const { c, hooks } = await setup(async () => json({ ok: true }, 201));
    hooks["/api/auth/login"] = () => {
      if (mode === "reject") throw Error("provider-secret");
      return json({ ok: true, user: null, authRevision: "rev-2" });
    };
    expect(await c.register("Alice", "raw-password", "fixture-only")).toEqual({
      registered: true,
    });
    expect(c.getSnapshot()).toMatchObject({
      mode: "login",
      error: "账号已创建，请登录",
      busy: false,
    });
  },
);
it("cancellation during registration error JSON parsing cannot overwrite newer state", async () => {
  const gate = deferred<unknown>();
  const response = json({}, 400);
  response.json = () => gate.promise;
  const { c } = await setup(async () => response);
  const pending = c.register("Alice", "raw-password", "wrong");
  await tick();
  c.cancelAuthentication();
  const state = c.getSnapshot();
  gate.resolve({ code: "INVITE_INVALID" });
  expect(await pending).toEqual({ registered: false });
  expect(c.getSnapshot().error).toBe(state.error);
});
it("renders username/password and secondary registration; no guest/config/provider prompts", async () => {
  const { c } = await setup();
  const html = renderToStaticMarkup(<CloudPanel controller={c} />);
  expect(html).toContain("用户名");
  expect(html).toContain('class="primary"');
  expect(html).toContain('class="auth-switch"');
  expect(html).not.toMatch(
    /邮箱|验证码|控制台|本机模式|Guest|找管理员|Supabase/,
  );
});
it("production BFF has no local bypass, independent of legacy public config", async () => {
  const h = harness();
  const c = await h.boot({
    env: { PROD: true, VITE_APP_MODE: "local", VITE_AUTH_MODE: "invite" },
  });
  await c.enterLocal();
  expect(c.getSnapshot().mode).toBe("login");
  expect(c.store.getSnapshot().namespace).toBeNull();
});
it("registration preserves exact same-origin body before BFF prepare/login", async () => {
  const request = vi.fn(async () => json({ ok: true }, 201));
  const { c, fetcher } = await setup(request);
  expect(await c.register("Alice", " raw password ", "fixture-only")).toEqual({
    registered: true,
  });
  expect(request).toHaveBeenCalledWith(
    "/api/register",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Alice",
        password: " raw password ",
        inviteCode: "fixture-only",
      }),
    }),
  );
  const login = fetcher.mock.calls.find(([p]) => p === "/api/auth/login")!;
  expect(JSON.parse(String(login[1]?.body))).toEqual({
    username: "Alice",
    password: " raw password ",
    authRevision: "rev-1",
    attemptId: "attempt-1",
  });
  expect(c.getSnapshot().mode).toBe("cloud");
});
it("registration preserves native fetch receiver and AbortSignal", async () => {
  let signal: AbortSignal | undefined;
  const request = vi.fn(function (
    this: unknown,
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    expect(this).toBe(globalThis);
    signal = init?.signal as AbortSignal;
    return Promise.resolve(json({ ok: true }, 201));
  });
  const { c } = await setup(request);
  await c.register("Alice", "raw-password", "fixture-only");
  expect(signal).toBeInstanceOf(AbortSignal);
});
it.each(["raw", "unknown-code"])(
  "registration %s never exposes raw details or invite errors",
  async (mode) => {
    const { c, fetcher } = await setup(async () =>
      mode === "raw"
        ? new Response("provider-secret", { status: 403 })
        : json({ code: "provider-secret" }, 400),
    );
    fetcher.mockClear();
    await c.register("Alice", "raw-password", "wrong");
    expect(c.getSnapshot().error).toBe("注册失败，请重试。");
    expect(c.getSnapshot().errorField).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each(["cancel", "signOut", "dispose"] as const)(
  "%s aborts registration and ignores late success",
  async (action) => {
    const gate = deferred<Response>();
    let signal: AbortSignal | undefined;
    const { c, fetcher } = await setup((_input, init) => {
      signal = init?.signal as AbortSignal;
      return gate.promise;
    });
    fetcher.mockClear();
    const pending = c.register("Alice", "raw-password", "fixture-only");
    const stop =
      action === "cancel"
        ? c.cancelAuthentication()
        : action === "signOut"
          ? c.signOut()
          : c.dispose();
    expect(signal?.aborted).toBe(true);
    gate.resolve(json({ ok: true }, 201));
    await Promise.all([pending, stop]);
    expect(fetcher.mock.calls.some(([p]) => p === "/api/auth/login")).toBe(
      false,
    );
    expect(c.store.getSnapshot().namespace).toBeNull();
  },
);
it("cancellation after registration headers but before successful body prevents auto-login", async () => {
  const gate = deferred<ArrayBuffer>();
  const response = json({ ok: true }, 201);
  response.arrayBuffer = () => gate.promise;
  const { c, fetcher } = await setup(async () => response);
  fetcher.mockClear();
  const pending = c.register("Alice", "raw-password", "fixture-only");
  await tick();
  c.cancelAuthentication();
  gate.resolve(new ArrayBuffer(0));
  expect(await pending).toEqual({ registered: false });
  expect(fetcher.mock.calls.some(([p]) => p === "/api/auth/login")).toBe(false);
});
it("uses backend verified display name, never client username claims", async () => {
  const { c, hooks } = await setup();
  hooks["/api/auth/login"] = (_i, f) => {
    f();
    return json({
      ok: true,
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        displayName: "Verified",
      },
      authRevision: "rev-2",
    });
  };
  await c.signIn("Alice", "password");
  expect(c.getSnapshot().displayName).toBe("Verified");
});
