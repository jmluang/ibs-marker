import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import type { CloudController } from "./bootstrap";
import type { Entry } from "../domain/types";
import { randomUuid } from "../domain/uuid";
export const useCloud = (controller: CloudController) =>
  useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
export function CloudPanel({ controller }: { controller: CloudController }) {
  const cloud = useCloud(controller);
  const state = useSyncExternalStore(
    controller.store.subscribe,
    controller.store.getSnapshot,
    controller.store.getSnapshot,
  );
  const [username, setUsername] = useState("");
  const [registering, setRegistering] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  useEffect(() => {
    const cancelPending = () => {
      if (controller.getSnapshot().busy) controller.cancelAuthentication();
    };
    window.addEventListener("hashchange", cancelPending);
    window.addEventListener("popstate", cancelPending);
    return () => {
      window.removeEventListener("hashchange", cancelPending);
      window.removeEventListener("popstate", cancelPending);
      cancelPending();
    };
  }, [controller]);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const visibleError = error ?? cloud.error;
  useEffect(() => {
    if (cloud.mode === "cloud") {
      setUsername("");
      setPassword("");
      setInviteCode("");
      setRegistering(false);
    }
  }, [cloud.mode]);
  const action = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch {
      setError("操作失败，请重试。");
    }
  };
  const login = (e: FormEvent) => {
    e.preventDefault();
    void action(async () => {
      if (registering) {
        const result = await controller.register(username, password, inviteCode);
        if (result.registered) {
          // Do not cancel: successful BFF login may still be opening its partition.
          setRegistering(false);
          setUsername("");
          setPassword("");
          setInviteCode("");
        }
      } else await controller.signIn(username, password);
    });
  };
  const copy = (id: string, snack = false) => {
    const conflict = state.conflicts.find((c) => c.resourceId === id);
    if (!conflict || conflict.local.kind !== "entry") return;
    const source = conflict.local.snapshot as Entry;
    const value: Entry = {
      ...source,
      id: randomUuid(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    if (value.kind === "meal" && value.slot !== "snack") {
      if (!snack) {
        setError(
          "正餐同日同餐次只能保留一个版本。请选择远端，或明确将本地副本转为加餐。",
        );
        return;
      }
      value.slot = "snack";
    }
    void action(async () => {
      await controller.store.resolveConflict(id, "copy-local", value);
      await controller.sync();
    });
  };
  return (
    <section
      className="rounded-2xl border border-stone-200 bg-white p-4 space-y-3"
      aria-label="云同步设置"
    >
      {!registering && <h2 className="text-lg font-semibold">账号与同步</h2>}
      {!registering && <p>
        {cloud.mode === "local"
          ? "仅本机：不会上传，浏览器清理数据可能丢失记录。"
          : cloud.connectionRetry && cloud.mode !== "cloud"
            ? "账号连接暂不可用，请重试连接。"
          : cloud.mode === "cloud"
            ? `云账号：${cloud.displayName ?? "已登录"}`
            : cloud.mode === "checking"
              ? "正在确认账号身份…"
              : "云端未登录：不会展示账号离线副本。"}
      </p>}
      {!registering && cloud.configuration === "ready" &&
        cloud.mode !== "local" &&
        typeof window !== "undefined" &&
        !window.isSecureContext && (
          <p className="notice">
            当前是 HTTP
            内网预览，建议先用专用测试账号。正式账号和健康记录请改用可信 HTTPS。
          </p>
        )}
      {!registering && cloud.configuration === "invalid" && (
        <p>
          暂时无法登录，请稍后重试。
        </p>
      )}
      {!registering && cloud.configuration === "absent" && (
        <p>开发用仅本机模式：不会连接云账号或上传记录。</p>
      )}
      {visibleError && (
        <p role="alert" className="text-red-700 break-words">
          {visibleError}
        </p>
      )}
      {cloud.connectionRetry && (
        <button type="button" className="border rounded p-2"
          onClick={() => void action(() => controller.retryConnection())}>
          重试连接
        </button>
      )}
      {cloud.mode === "login" && !cloud.connectionRetry && (
        <>
          <form onSubmit={login} className="space-y-2">
            <label className="block">
              用户名
              <input
                className="block w-full border rounded p-2"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={cloud.errorField === "username" || undefined}
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label className="block">
              密码
              <input
                className="block w-full border rounded p-2"
                type="password"
                autoComplete={registering ? "new-password" : "current-password"}
                required
                value={password}
                aria-invalid={cloud.errorField === "password" || undefined}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {registering && <input
              className="block w-full border rounded p-2"
              type="password"
              placeholder="输入邀请码"
              aria-label="输入邀请码"
              aria-invalid={cloud.errorField === "invite" || undefined}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
            />}
            <button
              className="primary"
              disabled={cloud.busy || cloud.configuration !== "ready"}
            >
              {registering ? "创建账号" : "登录"}
            </button>
          </form>
          <button type="button" className="auth-switch" onClick={() => {
            controller.cancelAuthentication();
            setRegistering(!registering);
            setUsername("");
            setPassword("");
            setInviteCode("");
            setError(null);
          }}>{registering ? "已有账号？去登录" : "还没有账号？去注册"}</button>
          {!cloud.privateMode && (
          <button
            className="border rounded p-2"
            onClick={() => void action(() => controller.enterLocal())}
          >
            明确进入仅本机模式（不导入账号数据）
          </button>)}
        </>
      )}
      {cloud.mode === "local" && cloud.configuration !== "absent" && (
        <button
          className="border rounded p-2"
          onClick={() => void action(() => controller.enterCloud())}
        >
          切回云账号登录
        </button>
      )}
      {cloud.mode === "cloud" && (
        <>
          <p role="status">
            同步状态：{state.syncStatus.state}；待同步 {state.outbox.length} 项
          </p>
          {state.syncStatus.message && <p>{state.syncStatus.message}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              className="border rounded p-2"
              disabled={state.syncStatus.state === "syncing"}
              onClick={() => void action(() => controller.sync())}
            >
              立即同步
            </button>
            <button
              className="border rounded p-2"
              onClick={() => {
                setPassword("");
                setUsername("");
                setInviteCode("");
                void action(() => controller.signOut());
              }}
            >
              退出本设备
            </button>
          </div>
          <p className="text-sm">
            退出会锁定本页但保留账号离线分区；这不是应用锁或数据库加密。网页关闭后不保证后台同步或提醒。
          </p>
          {state.conflicts.map((c) => (
            <article
              key={c.resourceId}
              className="border rounded p-3 space-y-2"
            >
              <h3>
                有冲突：{c.local.kind === "settings" ? "设置" : c.resourceId}
              </h3>
              <details>
                <summary>查看本地与远端（包含健康数据）</summary>
                <h4>本地待同步版本</h4>
                <pre className="whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(c.local.snapshot, null, 2)}
                </pre>
                <h4>
                  远端版本 {c.remote.version}
                  {c.remote.tombstone ? "（已删除）" : ""}
                </h4>
                <pre className="whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(c.remote.snapshot, null, 2)}
                </pre>
              </details>
              <button
                className="border rounded p-2"
                onClick={() =>
                  void action(async () => {
                    await controller.store.resolveConflict(
                      c.resourceId,
                      "remote",
                    );
                    await controller.sync();
                  })
                }
              >
                采用远端
              </button>
              {c.local.kind === "settings" ? (
                <button
                  className="border rounded p-2"
                  onClick={() =>
                    void action(async () => {
                      await controller.store.resolveConflict(
                        c.resourceId,
                        "retry-settings",
                      );
                      await controller.sync();
                    })
                  }
                >
                  以当前本地设置重试
                </button>
              ) : (
                <>
                  <button
                    className="border rounded p-2"
                    onClick={() => copy(c.resourceId)}
                  >
                    复制本地为新记录
                  </button>
                  {(c.local.snapshot as Entry).kind === "meal" &&
                    (c.local.snapshot as import("../domain/types").MealEntry)
                      .slot !== "snack" && (
                      <button
                        className="border rounded p-2"
                        onClick={() => copy(c.resourceId, true)}
                      >
                        明确将本地副本转为加餐
                      </button>
                    )}
                </>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
