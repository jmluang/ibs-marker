import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Entry, Settings } from "../domain/types";
import { completeness } from "../domain/helpers";
import { Timeline, formNames, slots } from "../components/ui";
import RangeDialog from "./stats/RangeDialog";
import { StatsModal } from "./stats/StatsModal";
import { TimeChart } from "./stats/TimeChart";
import {
  buildStatsPresentation,
  presetRange,
  type StatsRange,
} from "./stats/statsPresentation";
import "./stats/stats.css";
export { addDay, isValidDay, dateRangeError } from "./stats/statsPresentation";

type Modal = { kind: "range" } | { kind: "day"; day: string };
export default function StatsPage({
  entries,
  settings,
}: {
  entries: Entry[];
  settings: Settings;
}) {
  const [range, setRange] = useState<StatsRange>(() => presetRange("7"));
  const [tab, setTab] = useState("如厕");
  const [modal, setModal] = useState<Modal | null>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const release = useRef<(() => void) | null>(null);
  const shouldFocus = useRef(false);
  const data = useMemo(
    () => buildStatsPresentation(entries, range.from, range.to),
    [entries, range.from, range.to],
  );
  const complete = useMemo(
    () =>
      data.days.map((day) =>
        completeness(data.byDay.get(day) ?? [], day, settings),
      ),
    [data, settings],
  );
  const onReady = useCallback((dispose: () => void) => {
    release.current = dispose;
  }, []);
  const close = useCallback((focus: boolean) => {
    release.current?.();
    release.current = null;
    shouldFocus.current = focus;
    setModal(null);
  }, []);
  useLayoutEffect(() => {
    if (!modal && shouldFocus.current) {
      shouldFocus.current = false;
      const target = trigger.current?.isConnected
        ? trigger.current
        : chip.current;
      if (
        root.current?.isConnected &&
        target?.isConnected &&
        !target.closest("[inert]")
      )
        target.focus();
    }
  }, [modal, range]);
  useLayoutEffect(() => {
    const routeChanged = () => close(false);
    window.addEventListener("hashchange", routeChanged);
    return () => {
      window.removeEventListener("hashchange", routeChanged);
      shouldFocus.current = false;
      release.current?.();
      release.current = null;
    };
  }, [close]);
  const onDay = useCallback((day: string, source: HTMLButtonElement) => {
    trigger.current = source;
    setModal({ kind: "day", day });
  }, []);
  const stats = data.stats;
  return (
    <div ref={root} className="stats-page" data-testid="watercolor-stats">
      <header className="stats-heading">
        <h1>统计</h1>
        <button
          type="button"
          ref={chip}
          className="stats-range-chip"
          data-testid="stats-range-chip"
          aria-haspopup="dialog"
          aria-expanded={modal?.kind === "range"}
          aria-label={`${range.kind === "custom" ? "自定义" : `${range.kind}天`}，${range.from} 至 ${range.to}，选择统计范围`}
          onClick={() => {
            trigger.current = chip.current;
            setModal({ kind: "range" });
          }}
        >
          {range.kind === "custom" ? "自定义" : `${range.kind}天`}（
          {range.from.slice(5).replace("-", ".")}–
          {range.to.slice(5).replace("-", ".")}）
          <span aria-hidden="true">⌄</span>
        </button>
      </header>
      <div className="stats-tabs" aria-label="统计内容">
        {["如厕", "饮食回看"].map((label) => (
          <button
            type="button"
            key={label}
            aria-pressed={tab === label}
            onClick={() => setTab(label)}
          >
            {label}
          </button>
        ))}
      </div>
      {!data.entries.length && (
        <p className="stats-empty">
          这个范围还没有记录。未记录不代表没有发生。
        </p>
      )}
      {tab === "如厕" ? (
        <>
          <TimeChart rows={data.rows} onDay={onDay} />
          <div className="stats-section-heading stats-shape-heading">
            <h2>形态分布</h2>
            <small>{stats.stoolKnownSegments} 已知形态项</small>
          </div>
          <div className="stats-shapes">
            {[1, 2, 3, 4, 5, 6, 7]
              .filter((form) => stats.stoolForms[form] > 0)
              .map((form) => (
                <div
                  className="stats-shape-row"
                  data-testid="stats-shape-row"
                  data-form={form}
                  key={form}
                >
                  <span title={formNames[form - 1]}>{form} 型</span>
                  <i>
                    <em
                      style={{
                        width: `${(stats.stoolForms[form] / stats.stoolKnownSegments) * 100}%`,
                      }}
                    />
                  </i>
                  <span>{stats.stoolForms[form]}</span>
                </div>
              ))}
          </div>
          {!stats.stoolKnownSegments && (
            <p className="stats-note">暂无已知形态项</p>
          )}
          <div className="stats-compact-row">
            <span>未知形态项</span>
            <span>{stats.stoolForms.unknown} 项</span>
          </div>
          <p className="stats-note">
            仅有排出 · 同次多形态分别计项 · 隐藏 0 项类型
          </p>
          <div className="stats-compact-row">
            <span>不适报告 / 状态已知</span>
            <span>
              {stats.discomfortReported} / {stats.discomfortKnown} 条
            </span>
          </div>
          <p className="stats-note">
            未知另列 {stats.discomfortUnknown}{" "}
            条；来自如厕与独立不适记录，不是去重发作次数。
          </p>
          <div className="stats-compact-row">
            <span>平均用时</span>
            <span>{stats.averageDurationMinutes?.toFixed(1) ?? "—"} 分钟</span>
          </div>
          <p className="stats-note">
            时长已知 {stats.durationKnown} 条 · 缺失 {stats.durationMissing}{" "}
            条；未知不算 0。
          </p>
        </>
      ) : (
        <section className="stats-meal-review">
          <div className="stats-section-heading">
            <h2>饮食回看</h2>
          </div>
          <p className="stats-note">
            未记录不视为没吃；这里只回看，不推断食物与症状的因果。
          </p>
          {data.days
            .slice()
            .reverse()
            .map((day) => (
              <div className="stats-meal-day" key={day}>
                <h3>{day}</h3>
                {(["breakfast", "lunch", "dinner", "snack"] as const).map(
                  (slot) => {
                    const records = data.meals.get(day)?.get(slot) ?? [];
                    return (
                      <div className="stats-compact-row" key={slot}>
                        <span>{slots[slot]}</span>
                        <span>
                          {records.length
                            ? records
                                .map((e) =>
                                  e.status === "skipped"
                                    ? "明确没吃"
                                    : `吃了${e.foods ? ` · ${e.foods}` : ""}`,
                                )
                                .join("；")
                            : "未记"}
                        </span>
                      </div>
                    );
                  },
                )}
              </div>
            ))}
        </section>
      )}
      <details className="stats-data-notes">
        <summary>数据说明 · 已知与未知</summary>
        <p>
          仅有排出的形态数组逐项统计，一次可有多项。已知{" "}
          {stats.stoolKnownSegments} 形态项，未知 {stats.stoolForms.unknown}{" "}
          形态项；另有 {data.shapeMissing} 条有排出但形态数组为空。
        </p>
        <p>
          平均用时只含计时或估计的有限非负值，未知不算
          0。估计时点与估计用时是不同字段。
        </p>
        <p>
          不适分母包含如厕和独立不适中状态已知的记录（含明确无不适）；未知单列，不是去重发作次数。已删除记录不计。
        </p>
        <p>完整度只说明填写情况，不打健康分。同一记录可能有多个未知项。</p>
        {complete.map((c, i) => (
          <div className="stats-completeness" key={data.days[i]}>
            <strong>{data.days[i]}</strong>
            <span>
              启用餐次 {c.mealsConfirmed}/{c.mealsEnabled} · 事件确认项{" "}
              {c.eventConfirmed}/{c.eventExpected}
            </span>
            <small>缺失 / 未知 {c.missing.length} 项</small>
          </div>
        ))}
      </details>
      <p className="stats-note stats-disclaimer">
        记录仅用于个人回看，不提供诊断或医学判断。
      </p>
      {modal?.kind === "range" && (
        <RangeDialog
          value={range}
          onReady={onReady}
          onCancel={() => close(true)}
          onConfirm={(next) => {
            setRange(next);
            close(true);
          }}
        />
      )}
      {modal?.kind === "day" && (
        <StatsModal
          label={`${modal.day} 当日记录`}
          testId="stats-day-dialog"
          onReady={onReady}
          onCancel={() => close(true)}
        >
          <div className="stats-modal-handle" aria-hidden="true" />
          <header className="stats-modal-heading">
            <h2>{modal.day} 的记录</h2>
            <button
              type="button"
              aria-label="关闭当日记录"
              onClick={() => close(true)}
            >
              ×
            </button>
          </header>
          <Timeline
            entries={data.byDay.get(modal.day) ?? []}
            onEdit={(entry) => {
              close(false);
              window.location.hash = `edit/${entry.id}`;
            }}
          />
        </StatsModal>
      )}
    </div>
  );
}
