import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CalendarDays,
  NotebookText,
  ChartNoAxesColumn,
  SlidersHorizontal,
  Clock3,
  Leaf,
  Utensils,
  Activity,
} from "lucide-react";
import { trackerStore as store } from "./state/TrackerStore";
import { useTracker } from "./state/useTracker";
import type { Entry, MealEntry, MealSlot, ToiletEntry } from "./domain/types";
import {
  shanghaiDate,
  shanghaiTime,
  lastPassed,
  fromShanghai,
  completeness,
} from "./domain/helpers";
import EntryForm, { newEntry } from "./components/EntryForm";
import {
  Back,
  Choices,
  Timeline,
  slots,
  today,
  nowIso,
  errorText,
} from "./components/ui";
import StatsPage, { addDay, isValidDay } from "./pages/StatsPage";
import SettingsPage from "./pages/SettingsPage";
const nav = [
  ["today", "今天", CalendarDays],
  ["history", "历史", NotebookText],
  ["stats", "统计", ChartNoAxesColumn],
  ["settings", "设置", SlidersHorizontal],
] as const;
function go(route: string) {
  window.location.hash = route;
}
function useClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, []);
  return now;
}
export default function App({
  cloudPanel,
  onEnterLocal,
  privateMode = !(import.meta.env.VITE_APP_MODE === "local" && import.meta.env.PROD !== true),
  authenticated = false,
}: {
  cloudPanel?: ReactNode;
  privateMode?: boolean;
  authenticated?: boolean;
  onEnterLocal?: () => Promise<unknown>;
}) {
  const snapshot = useTracker();
  const [hash, setHash] = useState(() => location.hash.slice(1) || "today");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [day, setDay] = useState(today);
  const [filter, setFilter] = useState("all");
  const now = useClock();
  const dayNow = shanghaiDate(new Date(now).toISOString());
  const notified = useRef(new Set<string>());
  useEffect(() => {
    const fn = () => setHash(location.hash.slice(1) || "today");
    window.addEventListener("hashchange", fn);
    return () => window.removeEventListener("hashchange", fn);
  }, []);
  useEffect(() => {
    notified.current.clear();
    setError("");
  }, [snapshot.generation]);
  const currentMeals = snapshot.entries.filter(
    (e): e is MealEntry =>
      e.kind === "meal" && shanghaiDate(e.occurredAt) === dayNow,
  );
  function mealState(slot: MealSlot) {
    const entry = currentMeals.find((e) => e.slot === slot);
    const planned = Date.parse(
      fromShanghai(dayNow, snapshot.settings.meals[slot].time),
    );
    const snooze = Date.parse(
      snapshot.settings.snoozes[`${dayNow}:${slot}`] ?? "",
    );
    return {
      entry,
      planned,
      snooze,
      due:
        !entry &&
        snapshot.settings.meals[slot].enabled &&
        now >= planned &&
        !(snooze > now),
    };
  }
  useEffect(() => {
    if (!snapshot.namespace || !snapshot.settings.remindersEnabled) return;
    for (const slot of ["breakfast", "lunch", "dinner"] as const) {
      const m = mealState(slot);
      const key = `${snapshot.generation}:${dayNow}:${slot}:${m.snooze}`;
      if (
        m.due &&
        !notified.current.has(key) &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        notified.current.add(key);
        try {
          new Notification("有一条记录提醒", {
            body: "打开页面查看待记录事项。",
            tag: "fieldnotes-record",
          });
        } catch {
          /* Some mobile browsers expose permission but not the constructor; page cards remain available. */
        }
      }
    }
  }, [
    now,
    snapshot.namespace,
    snapshot.generation,
    snapshot.settings,
    currentMeals.length,
  ]);
  async function run(fn: () => Promise<unknown>) {
    setPending(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  }
  function edit(e: Entry) {
    go(`edit/${e.id}`);
  }
  function meal(slot: MealSlot | "snack") {
    const existing =
      slot === "snack" ? undefined : currentMeals.find((e) => e.slot === slot);
    if (existing) edit(existing);
    else go(`new/meal/${slot}`);
  }
  async function start() {
    await run(async () => {
      const t = await store.startTimer();
      go(t.endedAt ? "timer-form" : "timer");
    });
  }
  const formMatch =
    hash.startsWith("new/") ||
    hash.startsWith("edit/") ||
    hash === "timer-form";
  const formInitial = useRef<{ key: string; entry: Entry } | null>(null);
  const formGeneration = useRef(snapshot.generation);
  if (formGeneration.current !== snapshot.generation) {
    formInitial.current = null;
    formGeneration.current = snapshot.generation;
  }
  let form: ReactNode = null;
  if (formMatch && snapshot.namespace && !snapshot.loading && (!privateMode || authenticated)) {
    const parts = hash.split("/");
    let initial: Entry | undefined;
    let key =
      hash === "timer-form"
        ? `timer:${snapshot.timer?.id}`
        : parts[0] === "edit"
          ? `edit:${parts[1]}`
          : `new:${parts[1]}:${parts[2] ?? ""}`;
    if (hash === "timer-form") {
      const t = snapshot.timer;
      if (t?.endedAt)
        initial = {
          ...newEntry("toilet"),
          ...t.draft,
          id: t.id,
          startedAt: t.startedAt,
          endedAt: t.endedAt,
          occurredAt: t.startedAt,
          durationSource: "timer",
          estimatedDurationMinutes: null,
        } as ToiletEntry;
    } else if (parts[0] === "edit") {
      initial = snapshot.records[parts[1]];
      if (initial?.deletedAt) initial = undefined;
    } else if (["toilet", "meal", "symptom"].includes(parts[1])) {
      if (formInitial.current?.key === key) initial = formInitial.current.entry;
      else
        initial = newEntry(
          parts[1] as Entry["kind"],
          parts[2] as MealEntry["slot"] | undefined,
        );
    }
    if (initial) {
      formInitial.current = { key, entry: initial };
      form = (
        <EntryForm
          key={`${snapshot.generation}:${key}`}
          draftKey={key}
          initial={initial}
          timer={hash === "timer-form"}
          onClose={() => go("today")}
        />
      );
    } else
      form = (
        <>
          <Back onClick={() => go("today")} />
          <p className="empty">记录或计时已不存在，请返回。</p>
        </>
      );
  } else formInitial.current = null;
  const latest = lastPassed(snapshot.entries);
  const active = snapshot.timer;
  const seconds = active
    ? Math.max(
        0,
        Math.floor(
          ((active.endedAt ? Date.parse(active.endedAt) : now) -
            Date.parse(active.startedAt)) /
            1000,
        ),
      )
    : 0;
  const elapsed = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  if (!snapshot.namespace || (privateMode && (!authenticated || snapshot.namespace === "local")))
    return (
      <main className="app-shell welcome">
        <p className="eyebrow">肠记 / FIELDNOTES</p>
        <h1>记录，慢慢了解自己。</h1>
        {!privateMode && <p>选择账号继续，或仅在当前浏览器保存。未选择身份时不会展示旧记录。</p>}
        {cloudPanel ?? <p className="muted">云端账号尚未接入。</p>}
        {!privateMode && <button
          disabled={pending || snapshot.loading}
          className="primary"
          onClick={() =>
            void run(() =>
              onEnterLocal ? onEnterLocal() : store.activate("local"),
            )
          }
        >
          进入本机记录
        </button>}
        {(error || snapshot.error) && (
          <p role="alert" className="error">
            {error || snapshot.error}
          </p>
        )}
      </main>
    );
  return (
    <main
      className={`app-shell ${formMatch || hash === "timer" || hash.startsWith("meal-reminder/") ? "without-nav" : ""}`}
      key={`${snapshot.namespace}:${snapshot.generation}`}
    >
      {snapshot.loading ? (
        <p role="status">正在载入本机记录…</p>
      ) : formMatch ? (
        form
      ) : hash === "timer" ? (
        <div className="timer-page">
          <Back onClick={() => go("today")} />
          {active ? (
            <>
              <p className="eyebrow">
                <Clock3 size={30} />
              </p>
              <div className="stopwatch">{elapsed}</div>
              <p className="muted">
                开始时间 · {shanghaiDate(active.startedAt)}{" "}
                {shanghaiTime(active.startedAt)}
              </p>
              <section className="section">
                <h2>
                  {active.endedAt
                    ? "计时已结束，继续填写记录。"
                    : "结束时，再回来点一下。"}
                </h2>
                <p className="muted">
                  不需要保持页面打开。
                  <br />
                  离开页面或锁屏后，回来仍能继续记录。
                </p>
              </section>
              {!active.endedAt && (
                <label>
                  实际结束时间（忘记结束时可填写）
                  <input
                    aria-label="实际结束时间"
                    type="datetime-local"
                    id="timer-end"
                  />
                </label>
              )}
              <p className="notice">
                一次坐下到离开算一次如厕；分几波排出不需要重新开始。
              </p>
              <div className="form-actions">
                <button
                  disabled={pending}
                  className="primary"
                  onClick={() =>
                    void run(async () => {
                      if (!active.endedAt) {
                        const v = (
                          document.getElementById(
                            "timer-end",
                          ) as HTMLInputElement
                        )?.value;
                        await store.finishTimer(
                          v
                            ? new Date(`${v}:00+08:00`).toISOString()
                            : undefined,
                        );
                      }
                      go("timer-form");
                    })
                  }
                >
                  {active.endedAt ? "继续填写" : "结束如厕"}
                </button>
                <button
                  disabled={pending}
                  className="text-button"
                  onClick={() => {
                    if (confirm("确认丢弃这次计时？"))
                      void run(async () => {
                        await store.cancelTimer();
                        go("today");
                      });
                  }}
                >
                  误点了，取消本次
                </button>
              </div>
            </>
          ) : (
            <p>
              暂无活动计时 <button onClick={() => go("today")}>返回今天</button>
            </p>
          )}
        </div>
      ) : hash.startsWith("meal-reminder/") ? (
        (() => {
          const slot = hash.split("/")[1] as MealSlot;
          const m = mealState(slot);
          return (
            <>
              <Back onClick={() => go("today")} />
              <p className="eyebrow">有一餐还没记录</p>
              <div className="stopwatch">
                {snapshot.settings.meals[slot].time}
              </div>
              <h1>{slots[slot]}吃了什么？</h1>
              <p className="muted">记一下具体食物和实际进食时间。</p>
              <button className="primary" onClick={() => meal(slot)}>
                记录{slots[slot]}
              </button>
              <div className="choices mt-3">
                <button
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      const revision = store.getEditRevision("settings");
                      await store.saveSettings(
                        {
                          ...snapshot.settings,
                          snoozes: {
                            ...snapshot.settings.snoozes,
                            [`${dayNow}:${slot}`]: new Date(
                              now + 20 * 60000,
                            ).toISOString(),
                          },
                        },
                        revision,
                      );
                      go("today");
                    })
                  }
                >
                  20 分钟后提醒
                </button>
                <button
                  onClick={() => {
                    const e = newEntry("meal", slot) as MealEntry;
                    e.status = "skipped";
                    formInitial.current = { key: `new:meal:${slot}`, entry: e };
                    go(`new/meal/${slot}`);
                  }}
                >
                  这餐没吃，确认记录
                </button>
              </div>
              <p className="notice">
                没有回应时，只保留「未记录」，不会自动记成「没吃」。
              </p>
              <p className="muted">
                {m.entry ? "此餐已记录。" : "稍后提醒仅在页面运行时有效。"}
              </p>
              <button onClick={() => go("settings")}>调整三餐提醒 →</button>
            </>
          );
        })()
      ) : hash === "history" ? (
        <section className="watercolor-history" data-testid="watercolor-history">
          <h1>历史</h1>
          <div className="history-date">
            <button
              aria-label="前一天"
              onClick={() =>
                setDay(addDay(isValidDay(day) ? day : today(), -1))
              }
            >
              ‹
            </button>
            <label>
              上海日期
              <input
                aria-label="历史日期"
                type="date"
                value={day}
                onChange={(e) => setDay(e.target.value)}
              />
            </label>
            <button
              aria-label="后一天"
              onClick={() => setDay(addDay(isValidDay(day) ? day : today(), 1))}
            >
              ›
            </button>
          </div>
          <Choices
            label="记录类型"
            items={[
              ["all", "全部"],
              ["toilet", "如厕"],
              ["meal", "饮食"],
              ["symptom", "症状"],
            ]}
            value={filter}
            onChange={setFilter}
          />
          {!isValidDay(day) ? (
            <p role="status" className="notice">
              请选择有效的历史日期；前后一天将从今天开始导航。
            </p>
          ) : (
            <>
              <p className="day-caption">
                {day}{" "}
                <span className="blue">
                  待补充{" "}
                  {
                    completeness(snapshot.entries, day, snapshot.settings)
                      .missing.length
                  }{" "}
                  项
                </span>
              </p>
              <Timeline
                entries={snapshot.entries.filter(
                  (e) =>
                    shanghaiDate(e.occurredAt) === day &&
                    (filter === "all" || e.kind === filter),
                )}
                onEdit={edit}
              />
            </>
          )}
        </section>
      ) : hash === "stats" ? (
        <StatsPage key={snapshot.generation} entries={snapshot.entries} settings={snapshot.settings} />
      ) : hash === "settings" ? (
        <SettingsPage key={snapshot.generation} cloudPanel={cloudPanel} />
      ) : (
        <section className="watercolor-home" data-testid="watercolor-home">
          <header className="today-head">
            <h1><Leaf aria-hidden="true" size={25} strokeWidth={1.4} />肠记</h1>
            <time>
              {dayNow.slice(5).replace("-", ".")} /{" "}
              {new Intl.DateTimeFormat("zh-CN", {
                timeZone: "Asia/Shanghai",
                weekday: "short",
              }).format(new Date(now))}
            </time>
          </header>
          <div className="last-card">
            <div className="last-summary">
            <span>上次排便</span>
            <div className="last-date">
              {latest
                ? shanghaiDate(latest.occurredAt) === dayNow
                  ? "今天"
                  : shanghaiDate(latest.occurredAt)
                : "尚无记录"}
            <span className="last-time">
              {latest ? shanghaiTime(latest.occurredAt) : "— : —"}
            </span>
            </div>
            </div>
            <div className="last-actions">
              <button
                className="primary"
                disabled={pending}
                onClick={() =>
                  active
                    ? go(active.endedAt ? "timer-form" : "timer")
                    : start()
                }
              >
                {active
                  ? active.endedAt
                    ? "继续填写 ↗"
                    : `计时中 ${elapsed} ↗`
                  : "开始如厕 ↗"}
              </button>
            </div>
          </div>
          <p className="storage-label">
            {snapshot.namespace === "local"
              ? "仅本机保存"
              : snapshot.conflicts.length
                ? `${snapshot.conflicts.length} 项记录需要处理同步冲突`
                : snapshot.syncStatus.state === "syncing"
                  ? "正在同步记录…"
                  : snapshot.syncStatus.state === "offline"
                    ? "当前离线，记录保存在本机"
                    : snapshot.syncStatus.state === "auth"
                      ? "请重新登录后同步"
                      : snapshot.syncStatus.state === "error"
                        ? "同步暂未完成，请在设置中重试"
                        : snapshot.syncStatus.state === "conflict"
                          ? "有同步冲突，请在设置中处理"
                          : snapshot.outbox.length
                            ? `${snapshot.outbox.length} 项记录等待同步`
                            : "本机记录已保存，等待同步"}
          </p>
          <div className="home-shortcuts">
            <button onClick={() => meal("snack")}><Utensils size={20} aria-hidden="true" />记饮食<span aria-hidden="true">＋</span></button>
            <button onClick={() => go("new/symptom")}><Activity size={20} aria-hidden="true" />记录独立症状<span aria-hidden="true">＋</span></button>
          </div>
          <div className="meal-heading"><h2>三餐小记</h2></div>
          <div className="meals">
            {(["breakfast", "lunch", "dinner"] as const).map((slot) => {
              const m = mealState(slot);
              return (
                <button
                  className={m.due ? "meal-card due" : "meal-card"}
                  key={slot}
                  onClick={() =>
                    m.entry ? edit(m.entry) : go(`meal-reminder/${slot}`)
                  }
                >
                  <strong>{slots[slot]}</strong>
                  <span className={m.entry ? "blue" : ""}>
                    {m.entry
                      ? m.entry.status === "skipped"
                        ? "✓ 明确没吃"
                        : "✓ 已记录"
                      : !snapshot.settings.meals[slot].enabled
                        ? "提醒已关闭"
                        : m.snooze > now
                          ? "◷ 已稍后"
                          : now - m.planned >= 7200000
                            ? "! 过时未记录"
                            : now >= m.planned
                              ? "待记录"
                              : "◷ 未到时间"}
                  </span>
                  <small>
                    {m.entry
                      ? shanghaiTime(m.entry.occurredAt) + " 用餐"
                      : snapshot.settings.meals[slot].time + " 提醒"}
                  </small>
                </button>
              );
            })}
          </div>
          <div className="timeline-heading">
            <h2>今天记录</h2>
            <button className="record-supplement" onClick={() => go("new/toilet")}>补记如厕 ＋</button>
          </div>
          <Timeline
            entries={snapshot.entries.filter(
              (e) => shanghaiDate(e.occurredAt) === dayNow,
            )}
            onEdit={edit}
          />
          <div className="record-tools"><details className="add-menu">
            <summary>其他记录 ＋</summary>
            <div>
              <button onClick={() => go("new/symptom")}>记录独立症状</button>
              <button onClick={() => meal("snack")}>记录加餐 / 饮料</button>
            </div>
          </details></div>
        </section>
      )}
      {(error || snapshot.error) && (
        <div className="error" role="alert">
          {error || snapshot.error}
          <button
            disabled={pending}
            onClick={() => void run(() => store.reload())}
          >
            重新载入
          </button>
        </div>
      )}
      {!formMatch && hash !== "timer" && !hash.startsWith("meal-reminder/") && (
        <nav className="bottom-nav" aria-label="主导航">
          {nav.map(([key, label, Icon]) => (
            <button
              aria-current={hash === key ? "page" : undefined}
              key={key}
              onClick={() => go(key)}
            >
              <Icon size={20} strokeWidth={1.5} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      )}
    </main>
  );
}
