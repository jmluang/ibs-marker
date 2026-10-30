import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import type { Entry, MealEntry, Discomfort } from "../domain/types";
import { durationMinutes, shanghaiDate, shanghaiTime } from "../domain/helpers";
export const slots = {
  breakfast: "早餐",
  lunch: "午餐",
  dinner: "晚餐",
  snack: "加餐 / 饮料",
};
export const symptomNames = {
  pain: "腹痛",
  bloating: "腹胀",
  urgency: "急迫感",
  nausea: "恶心",
  other: "其它",
};
export const severityNames = {
  mild: "轻",
  moderate: "中",
  severe: "重",
  unknown: "程度未知",
};
export const formNames = [
  "颗粒",
  "结块",
  "裂纹",
  "光滑",
  "软块",
  "糊状",
  "水样",
];
export const nowIso = () => new Date().toISOString();
export const today = () => shanghaiDate(nowIso());
export const inputTime = (iso: string) =>
  `${shanghaiDate(iso)}T${shanghaiTime(iso)}`;
export const parseTime = (v: string) => new Date(`${v}:00+08:00`).toISOString();
export function errorText(e: unknown) {
  const s = String(e);
  return s.includes("STALE_REVISION")
    ? "此记录已在另一标签页修改。你的输入已保留，请返回并重新载入记录后再修改。"
    : s.includes("MEAL_SLOT_EXISTS")
      ? "当天这餐已有记录，请返回历史记录编辑。"
      : s.includes("STALE_IDENTITY")
        ? "身份已切换，请重新打开表单。"
        : `未能保存，请重试。${s}`;
}
export function Back({
  onClick,
  children,
}: {
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="form-head">
      <button type="button" onClick={onClick}>
        <ArrowLeft size={17} /> 返回
      </button>
      {children}
    </header>
  );
}
export function Choices<T extends string | number>({
  label,
  items,
  value,
  onChange,
  multi = false,
}: {
  label: string;
  items: readonly (readonly [T, string])[];
  value: T | T[];
  onChange: (v: T) => void;
  multi?: boolean;
}) {
  return (
    <fieldset className="choice-field">
      <legend>{label}</legend>
      <div className="choices">
        {items.map(([v, text]) => (
          <button
            type="button"
            key={v}
            aria-pressed={
              multi ? Array.isArray(value) && value.includes(v) : value === v
            }
            onClick={() => onChange(v)}
          >
            {text}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
export function discomfortText(d: Discomfort) {
  return d.status === "unknown"
    ? "不适未记录"
    : d.status === "none"
      ? "无上述不适"
      : d.symptoms
          .map((s) => `${symptomNames[s.name]}·${severityNames[s.severity]}`)
          .join(" / ");
}
export function entryTitle(e: Entry) {
  return e.kind === "meal"
    ? e.status === "skipped"
      ? "这餐没吃"
      : e.foods || "已用餐"
    : e.kind === "symptom"
      ? discomfortText(e.discomfort)
      : e.result === "none"
        ? "没有排出"
        : e.result === "unsure"
          ? "排便结果不确定"
          : e.stoolForms
              .map((f) =>
                f === "unknown" ? "形态没看清" : `${f} 型${formNames[f - 1]}`,
              )
              .join(" → ");
}
export function Timeline({
  entries,
  onEdit,
}: {
  entries: Entry[];
  onEdit: (e: Entry) => void;
}) {
  return entries.length ? (
    <div className="timeline">
      {[...entries]
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
        .map((e) => {
          const minutes = e.kind === "toilet" ? durationMinutes(e) : null;
          return (
            <button
              type="button"
              className={`entry entry-${e.kind}`}
              key={e.id}
              onClick={() => onEdit(e)}
            >
              <span className="entry-top">
                <time>
                  {shanghaiTime(e.occurredAt)}
                  {e.estimatedTime ? " · 估计" : ""}
                </time>
                <span className="blue">
                  {e.kind === "toilet"
                    ? "如厕"
                    : e.kind === "symptom"
                      ? "症状"
                      : slots[(e as MealEntry).slot]}{" "}
                  ↗
                </span>
              </span>
              <strong>{entryTitle(e)}</strong>
              <span className="entry-detail">
                {e.kind === "toilet"
                  ? `${discomfortText(e.discomfort)} · ${minutes === null ? "时长未知" : e.durationSource === "estimated" ? "手动估时 " + minutes + " 分钟" : "计时 " + minutes.toFixed(1) + " 分钟"}`
                  : e.kind === "meal"
                    ? e.tags.join("、")
                    : e.context}
                {e.note ? ` · ${e.note}` : ""}
              </span>
            </button>
          );
        })}
    </div>
  ) : (
    <div className="empty">
      还没有记录
      <p>
        从一次如厕、一餐或身体感受开始。
        <br />
        没有记录，不代表没有发生。
      </p>
    </div>
  );
}
export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
