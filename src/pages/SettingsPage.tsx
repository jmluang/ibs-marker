import { useEffect, useRef, useState, type ReactNode } from "react";
import { trackerStore as store } from "../state/TrackerStore";
import { useTracker } from "../state/useTracker";
import { exportCsv, exportJson } from "../domain/helpers";
import type { Settings } from "../domain/types";
import { slots, errorText } from "../components/ui";
import fontLicense from "../assets/XIAOLAI-OFL.txt?raw";
import "./settings.css";
export default function SettingsPage({
  cloudPanel,
}: {
  cloudPanel?: ReactNode;
}) {
  const snapshot = useTracker();
  const recovered = snapshot.drafts["settings:editor"] as
    { settings: Settings; baseRevision: number; template: string } | undefined;
  const [settings, setSettings] = useState<Settings>(() =>
    structuredClone(recovered?.settings ?? snapshot.settings),
  );
  const [revision, setRevision] = useState(
    () => recovered?.baseRevision ?? store.getEditRevision("settings"),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [template, setTemplate] = useState(recovered?.template ?? "");
  const token = useRef(store.identityToken());
  const queue = useRef(Promise.resolve());
  const clean = useRef(
    JSON.stringify({ settings: snapshot.settings, template: "" }),
  );
  useEffect(() => {
    if (JSON.stringify({ settings, template }) === clean.current) return;
    setStatus("正在暂存设置草稿…");
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        if (!store.isCurrent(token.current)) return;
        await store.saveDraft("settings:editor", {
          settings,
          baseRevision: revision,
          template,
        });
        if (store.isCurrent(token.current))
          setStatus("设置草稿已保存在本机；点击保存设置后生效");
      })
      .catch((e) => setError(errorText(e)));
  }, [settings, template, revision]);
  async function save(next = settings) {
    setPending(true);
    setStatus("");
    setError("");
    try {
      await queue.current;
      if (!store.isCurrent(token.current)) throw Error("STALE_IDENTITY");
      await store.saveSettings(next, revision);
      if (!store.isCurrent(token.current)) return;
      clean.current = JSON.stringify({ settings: next, template });
      await store.clearDraft("settings:editor");
      setRevision(store.getEditRevision("settings"));
      setSettings(structuredClone(next));
      setStatus("设置已保存");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  }
  async function reloadSettings() {
    if (!confirm("放弃设置草稿并载入最新设置？未保存的组合和时间修改会丢失。"))
      return;
    setPending(true);
    try {
      await queue.current;
      if (!store.isCurrent(token.current)) return;
      await store.clearDraft("settings:editor");
      await store.reload();
      if (!store.isCurrent(token.current)) return;
      const latest = store.getSnapshot().settings;
      clean.current = JSON.stringify({ settings: latest, template: "" });
      setSettings(structuredClone(latest));
      setTemplate("");
      setRevision(store.getEditRevision("settings"));
      setError("");
      setStatus("已载入最新设置");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  }
  function download(kind: "json" | "csv") {
    if (
      !confirm(
        "导出含敏感健康记录、发生时间和备注。请妥善保管，避免共享给无关人员。继续下载？",
      )
    )
      return;
    const text =
      kind === "json"
        ? exportJson(snapshot.entries, snapshot.settings)
        : exportCsv(snapshot.entries);
    const url = URL.createObjectURL(
      new Blob([text], {
        type:
          kind === "json"
            ? "application/json;charset=utf-8"
            : "text/csv;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `肠记-${new Date().toISOString().slice(0, 10)}.${kind}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function clear() {
    if (
      !confirm(
        `将清除此身份在本机的记录、草稿和计时，待同步队列有 ${snapshot.outbox.length} 项。建议先导出备份。此操作不会删除云端数据。确认清理？`,
      )
    )
      return;
    setPending(true);
    try {
      await queue.current;
      if (!store.isCurrent(token.current)) throw Error("STALE_IDENTITY");
      await store.clearCurrentNamespace(true);
      if (!store.isCurrent(token.current)) return;
      clean.current = JSON.stringify({
        settings: store.getSnapshot().settings,
        template: "",
      });
      setTemplate("");
      setSettings(structuredClone(store.getSnapshot().settings));
      setRevision(store.getEditRevision("settings"));
      setStatus("本机数据已清理");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="settings-page" data-testid="watercolor-settings">
      <h1>设置</h1>
      <form
        className="settings-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={pending}>
          <section className="settings-section settings-reminders">
            <h2>三餐提醒</h2>
            {(["breakfast", "lunch", "dinner"] as const).map((slot) => (
              <div className="meal-setting" key={slot}>
                <label htmlFor={`time-${slot}`}>{slots[slot]}</label>
                <input
                  id={`time-${slot}`}
                  aria-label={`${slots[slot]}提醒时间`}
                  type="time"
                  value={settings.meals[slot].time}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      meals: {
                        ...settings.meals,
                        [slot]: {
                          ...settings.meals[slot],
                          time: e.target.value,
                        },
                      },
                    })
                  }
                />
                <button
                  type="button"
                  aria-pressed={settings.meals[slot].enabled}
                  className="settings-toggle"
                  aria-label={`${slots[slot]}提醒`}
                  onClick={() =>
                    setSettings({
                      ...settings,
                      meals: {
                        ...settings.meals,
                        [slot]: {
                          ...settings.meals[slot],
                          enabled: !settings.meals[slot].enabled,
                        },
                      },
                    })
                  }
                >
                  {settings.meals[slot].enabled ? "已开启" : "已关闭"}
                </button>
              </div>
            ))}
            <details className="settings-reminder-help">
              <summary>提醒说明</summary>
              <p className="muted">
                提醒后 2 小时仍未填，标为过时未记录。
                已记录或明确没吃后停止该餐提醒。
              </p>
            </details>
            <label className="settings-foreground">
              <input
                type="checkbox"
                checked={settings.remindersEnabled}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    remindersEnabled: e.target.checked,
                  })
                }
              />
              开启前台记录提醒
            </label>
            <p className="muted">
              仅页面运行时提醒，不提供后台推送。未开启浏览器通知时，首页仍显示待记录的餐次。未响应不代表没吃。
            </p>
            <button
              type="button"
              onClick={async () => {
                // Permission remains a user-initiated action, never an effect.
                if (!("Notification" in window)) {
                  setStatus("浏览器不支持通知，使用页面提示");
                  return;
                }
                try {
                  const p = await Notification.requestPermission();
                  setStatus(
                    p === "granted"
                      ? "已授权中性记录通知；仅页面运行时有效"
                      : "未授权，使用页面提示",
                  );
                } catch {
                  setStatus("无法启用通知，使用页面提示");
                }
              }}
            >
              浏览器通知 ·{" "}
              {typeof Notification !== "undefined" &&
              Notification.permission === "granted"
                ? "已授权"
                : "未开启"}{" "}
              →
            </button>
          </section>
          <section className="settings-section settings-foods">
            <h2>常用食物组合</h2>
            <p className="muted">复用后仍需确认保存，不自动生成饮食记录。</p>
            {settings.foodTemplates.map((f, i) => (
              <div className="template-row" key={i}>
                <input
                  aria-label={`食物组合${i + 1}`}
                  value={f}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      foodTemplates: settings.foodTemplates.map((v, n) =>
                        n === i ? e.target.value : v,
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  aria-label={`删除食物组合${i + 1}`}
                  onClick={() =>
                    setSettings({
                      ...settings,
                      foodTemplates: settings.foodTemplates.filter(
                        (_, n) => n !== i,
                      ),
                    })
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <label className="settings-new-label">
              新组合
              <input
                placeholder="例如：牛奶 + 面包"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={!template.trim()}
              onClick={() => {
                setSettings({
                  ...settings,
                  foodTemplates: [...settings.foodTemplates, template.trim()],
                });
                setTemplate("");
              }}
            >
              ＋ 添加组合
            </button>
          </section>
          <button className="primary" type="submit">
            {pending ? "保存中…" : "保存设置"}
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => void reloadSettings()}
          >
            放弃草稿并载入最新设置
          </button>
        </fieldset>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <p role="status" className="muted">
        {status}
      </p>
      <section className="settings-section settings-account">
        <h2>账号与保存</h2>
        <p>
          {snapshot.namespace === "local"
            ? "仅本机保存 · 不会自动上传"
            : "云端账号 · 待同步 " + snapshot.outbox.length + " 项"}
        </p>
        {cloudPanel ?? (
          <p className="muted">
            云端账号尚未接入，现有记录仅保存在当前浏览器。
          </p>
        )}
      </section>
      <section className="settings-section settings-privacy">
        <h2>数据与隐私</h2>
        <p className="muted">
          含实际发生时间、估计标记及未知字段。导出文件包含敏感健康资料。
        </p>
        <div className="settings-exports">
          <button onClick={() => download("json")}>下载 JSON</button>
          <button onClick={() => download("csv")}>下载 CSV</button>
        </div>
        <button
          disabled={pending}
          className="danger settings-clear"
          onClick={() => void clear()}
        >
          清理此身份的本机数据
        </button>
      </section>
      <section className="settings-section settings-about">
        <h2>关于</h2>
        <p className="muted">
          帮助你回看自己的记录，不提供医学判断。照片、AI
          分析与后台推送尚未接入。
        </p>
        <details className="settings-license">
          <summary>字体许可</summary>
          <pre>{fontLicense}</pre>
        </details>
      </section>
    </div>
  );
}
