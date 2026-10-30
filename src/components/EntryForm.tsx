import { useEffect, useRef, useState } from "react";
import type {
  Entry,
  ToiletEntry,
  MealEntry,
  SymptomEntry,
  Discomfort,
  StoolForm,
  Severity,
  SymptomName,
} from "../domain/types";
import { trackerStore as store } from "../state/TrackerStore";
import { useTracker } from "../state/useTracker";
import {
  applyDurationEdit,
  durationMinutes,
  parseDurationInput,
  validateEntry,
} from "../domain/helpers";
import { randomUuid } from "../domain/uuid";
import {
  Back,
  Choices,
  slots,
  symptomNames,
  severityNames,
  formNames,
  nowIso,
  inputTime,
  parseTime,
  errorText,
} from "./ui";
type Draft = {
  entry: Entry;
  baseRevision: number;
  editing: boolean;
  // UI intent/text only: never part of the persisted Entry or sync/export model.
  durationEdited?: boolean;
  durationRaw?: string;
  durationExpanded?: boolean;
};
export function newEntry(
  kind: Entry["kind"],
  slot: MealEntry["slot"] = "snack",
): Entry {
  const at = nowIso();
  const common = {
    id: randomUuid(),
    kind,
    occurredAt: at,
    createdAt: at,
    updatedAt: at,
    estimatedTime: false,
    deletedAt: null,
    note: "",
  };
  if (kind === "meal")
    return {
      ...common,
      kind,
      status: "eaten",
      slot,
      foods: "",
      tags: [],
      portion: "unknown",
    };
  if (kind === "symptom")
    return {
      ...common,
      kind,
      discomfort: { status: "unknown", symptoms: [] },
      context: "",
    };
  return {
    ...common,
    kind,
    result: "unsure",
    stoolForms: [],
    discomfort: { status: "unknown", symptoms: [] },
    startedAt: null,
    endedAt: null,
    durationSource: "unknown",
    estimatedDurationMinutes: null,
    relief: "unknown",
  };
}
function DiscomfortFields({
  value,
  onChange,
}: {
  value: Discomfort;
  onChange: (v: Discomfort) => void;
}) {
  return (
    <>
      <Choices
        label="有不适或困难吗？"
        items={[
          ["reported", "有"],
          ["none", "无"],
          ["unknown", "不确定"],
        ]}
        value={value.status}
        onChange={(status) =>
          onChange(
            status === "reported"
              ? { status, symptoms: [{ name: "pain", severity: "unknown" }] }
              : { status, symptoms: [] },
          )
        }
      />
      {value.status === "reported" && (
        <>
          <Choices
            label="不适症状 · 可多选"
            items={Object.entries(symptomNames) as [SymptomName, string][]}
            value={value.symptoms.map((s) => s.name)}
            multi
            onChange={(name) => {
              const exists = value.symptoms.some((s) => s.name === name);
              onChange({
                status: "reported",
                symptoms: exists
                  ? value.symptoms.filter((s) => s.name !== name)
                  : [...value.symptoms, { name, severity: "unknown" }],
              });
            }}
          />
          {value.symptoms.map((symptom) => (
            <label className="inline-field" key={symptom.name}>
              {symptomNames[symptom.name]}程度
              <select
                value={symptom.severity}
                onChange={(e) =>
                  onChange({
                    status: "reported",
                    symptoms: value.symptoms.map((s) =>
                      s.name === symptom.name
                        ? { ...s, severity: e.target.value as Severity }
                        : s,
                    ),
                  })
                }
              >
                {Object.entries(severityNames).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </>
      )}
    </>
  );
}
export default function EntryForm({
  initial,
  draftKey,
  timer = false,
  onClose,
}: {
  initial: Entry;
  draftKey: string;
  timer?: boolean;
  onClose: () => void;
}) {
  const snapshot = useTracker();
  const [draft, setDraft] = useState<Draft>(() => {
    const saved = snapshot.drafts[draftKey] as Draft | undefined;
    if (saved?.entry?.id && saved.entry.kind === initial.kind) return saved;
    return {
      entry: initial,
      baseRevision: store.getEditRevision(initial.id),
      editing: !!snapshot.records[initial.id],
    };
  });
  const entry = draft.entry;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [draftStatus, setDraftStatus] = useState("正在保存草稿…");
  const queue = useRef(Promise.resolve());
  const alive = useRef(true);
  const stopping = useRef(false);
  const token = useRef(store.identityToken());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (stopping.current || !store.isCurrent(token.current)) return;
    setDraftStatus("正在保存草稿…");
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        if (!store.isCurrent(token.current)) return;
        await store.saveDraft(draftKey, draft);
      })
      .then(() => {
        if (alive.current) setDraftStatus("草稿已保存在本机");
      })
      .catch((e) => {
        if (alive.current) {
          setDraftStatus("草稿保存失败");
          setError(errorText(e));
        }
      });
  }, [draft, draftKey]);
  const update = (fields: Partial<Entry>) =>
    setDraft((d) => ({ ...d, entry: { ...d.entry, ...fields } as Entry }));
  // Legacy timer-form drafts may contain the default unknown rather than a clear.
  // Only explicit intent can override the actual clock duration in this flow.
  const durationEntry =
    entry.kind === "toilet"
      ? timer && !draft.durationEdited
        ? {
            ...entry,
            startedAt:
              snapshot.timer?.id === entry.id
                ? snapshot.timer.startedAt
                : initial.kind === "toilet"
                  ? initial.startedAt
                  : entry.startedAt,
            endedAt:
              snapshot.timer?.id === entry.id
                ? snapshot.timer.endedAt
                : initial.kind === "toilet"
                  ? initial.endedAt
                  : entry.endedAt,
            durationSource: "timer" as const,
            estimatedDurationMinutes: null,
          }
        : entry
      : null;
  const durationValue = durationEntry ? durationMinutes(durationEntry) : null;
  const durationRaw =
    draft.durationRaw ?? (durationValue === null ? "" : String(durationValue));
  const durationInvalid =
    entry.kind === "toilet" &&
    draft.durationRaw !== undefined &&
    !parseDurationInput(draft.durationRaw).valid;
  const durationCorrection =
    timer ||
    (initial.kind === "toilet" && initial.durationSource === "timer") ||
    draft.durationExpanded !== undefined;
  const changeDuration = (raw: string) => {
    setDraft((d) => {
      if (d.entry.kind !== "toilet") return d;
      // Use the clock-backed view for untouched legacy timer drafts as well.
      const original =
        timer && !d.durationEdited && durationEntry
          ? {
              ...d.entry,
              startedAt: durationEntry.startedAt,
              endedAt: durationEntry.endedAt,
              durationSource: "timer" as const,
              estimatedDurationMinutes: null,
            }
          : d.entry;
      const next = applyDurationEdit(original, raw, d.durationEdited);
      return {
        ...d,
        entry: next.durationEdited ? next.entry : d.entry,
        durationEdited: next.durationEdited,
        durationRaw: raw,
      };
    });
  };
  async function save() {
    setError("");
    if (durationInvalid) return;
    if (validateEntry(entry).length) {
      setError(
        "请补充有效的时间、排出后的形态和不适选项。选择有不适时请至少选一个症状。",
      );
      return;
    }
    setPending(true);
    try {
      await queue.current;
      if (!store.isCurrent(token.current)) throw Error("STALE_IDENTITY");
      const saved = { ...entry, updatedAt: nowIso() };
      if (timer)
        await store.finalizeTimer(saved as ToiletEntry, {
          expectedRevision: draft.baseRevision,
          durationEdited: draft.durationEdited === true,
        });
      else await store.saveEntry(saved, draft.baseRevision);
      if (!store.isCurrent(token.current)) return;
      stopping.current = true;
      await store.clearDraft(draftKey);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  }
  async function remove() {
    if (!confirm("确认删除这条记录？此操作也会加入同步队列。")) return;
    setPending(true);
    try {
      await queue.current;
      if (!store.isCurrent(token.current)) throw Error("STALE_IDENTITY");
      await store.deleteEntry(entry.id, draft.baseRevision);
      if (!store.isCurrent(token.current)) return;
      stopping.current = true;
      await store.clearDraft(draftKey);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setPending(false);
    }
  }
  async function discard() {
    if (
      !confirm(
        timer ? "丢弃这次计时和表单草稿？" : "丢弃这个尚未保存的表单草稿？",
      )
    )
      return;
    setPending(true);
    try {
      await queue.current;
      if (!store.isCurrent(token.current)) throw Error("STALE_IDENTITY");
      stopping.current = true;
      if (timer) await store.cancelTimer();
      if (!store.isCurrent(token.current)) return;
      await store.clearDraft(draftKey);
      onClose();
    } catch (e) {
      stopping.current = false;
      setError(errorText(e));
      setPending(false);
    }
  }
  const e = entry;
  return (
    <div className="form-page">
      <Back
        onClick={() => {
          void queue.current.then(onClose);
        }}
      >
        <span>
          {draft.editing
            ? "编辑记录"
            : timer
              ? "填写如厕记录"
              : e.kind === "meal"
                ? "记录饮食"
                : e.kind === "symptom"
                  ? "独立症状"
                  : "补记如厕"}
        </span>
      </Back>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={pending} className="form-body">
          <label>
            实际发生时间（上海时间）
            <input
              type="datetime-local"
              required
              value={inputTime(e.occurredAt)}
              onChange={(event) => {
                try {
                  update({ occurredAt: parseTime(event.target.value) });
                } catch {
                  setError("请输入有效时间");
                }
              }}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={e.estimatedTime}
              onChange={(event) =>
                update({ estimatedTime: event.target.checked })
              }
            />
            时间为估计
          </label>
          {e.kind === "toilet" && (
            <>
              <Choices
                label="有排出吗？"
                items={[
                  ["passed", "有"],
                  ["none", "无"],
                  ["unsure", "不确定"],
                ]}
                value={e.result}
                onChange={(result) =>
                  update({
                    result,
                    stoolForms: result === "passed" ? e.stoolForms : [],
                  } as Partial<ToiletEntry>)
                }
              />
              {e.result === "passed" && (
                <fieldset className="choice-field">
                  <legend>大便形态 · 按发生顺序多选</legend>
                  <div className="stool-grid">
                    {([1, 2, 3, 4, 5, 6, 7, "unknown"] as StoolForm[]).map(
                      (f) => (
                        <button
                          type="button"
                          key={f}
                          aria-pressed={e.stoolForms.includes(f)}
                          onClick={() =>
                            update({
                              stoolForms: [...e.stoolForms, f],
                            } as Partial<ToiletEntry>)
                          }
                        >
                          <svg aria-hidden="true">
                            <use href={`/stool-forms.svg#form-${f}`} />
                          </svg>
                          <span>
                            {f === "unknown"
                              ? "? 没看清"
                              : `${f} ${formNames[f - 1]}`}
                          </span>
                        </button>
                      ),
                    )}
                  </div>
                  <p className="muted">按顺序点击追加，可调整顺序。</p>
                  <ol className="form-order">
                    {e.stoolForms.map((f, i) => (
                      <li key={i}>
                        <span>{f === "unknown" ? "没看清" : `${f} 型`}</span>
                        <button
                          type="button"
                          aria-label={`形态${i + 1}上移`}
                          disabled={i === 0}
                          onClick={() => {
                            const a = [...e.stoolForms];
                            [a[i - 1], a[i]] = [a[i], a[i - 1]];
                            update({ stoolForms: a } as Partial<ToiletEntry>);
                          }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`删除形态${i + 1}`}
                          onClick={() =>
                            update({
                              stoolForms: e.stoolForms.filter(
                                (_, n) => n !== i,
                              ),
                            } as Partial<ToiletEntry>)
                          }
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ol>
                </fieldset>
              )}
              <DiscomfortFields
                value={e.discomfort}
                onChange={(discomfort) =>
                  update({ discomfort } as Partial<ToiletEntry>)
                }
              />
              <Choices
                label="排后有缓解吗？"
                items={[
                  ["yes", "有"],
                  ["partial", "部分"],
                  ["no", "无"],
                  ["unknown", "不确定"],
                ]}
                value={e.relief}
                onChange={(relief) =>
                  update({ relief } as Partial<ToiletEntry>)
                }
              />
              {durationCorrection ? (
                <>
                  <p className="notice">
                    {durationEntry?.durationSource === "timer"
                      ? `计时时长：${durationValue?.toFixed(1) ?? "—"} 分钟（按开始 / 结束时间计算）`
                      : durationValue === null
                        ? "时长未知"
                        : `手动估时 ${durationValue} 分钟`}{" "}
                    <button
                      type="button"
                      aria-expanded={draft.durationExpanded === true}
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          durationExpanded: !d.durationExpanded,
                        }))
                      }
                    >
                      {draft.durationExpanded ? "收起" : "修改用时"}
                    </button>
                  </p>
                  {draft.durationExpanded && (
                    <label>
                      用时（分钟）
                      <input
                        type="text"
                        inputMode="decimal"
                        value={durationRaw}
                        aria-invalid={durationInvalid}
                        aria-describedby={
                          durationInvalid ? "duration-error" : undefined
                        }
                        onChange={(event) => changeDuration(event.target.value)}
                      />
                    </label>
                  )}
                </>
              ) : (
                <>
                  <Choices
                    label="补记耗时"
                    items={[
                      ["unknown", "未知"],
                      ["estimated", "估计"],
                    ]}
                    value={e.durationSource}
                    onChange={(durationSource) =>
                      changeDuration(durationSource === "estimated" ? "5" : "")
                    }
                  />
                  {e.durationSource === "estimated" && (
                    <label>
                      估计耗时（分钟）
                      <input
                        type="text"
                        inputMode="decimal"
                        value={durationRaw}
                        aria-invalid={durationInvalid}
                        aria-describedby={
                          durationInvalid ? "duration-error" : undefined
                        }
                        onChange={(event) => changeDuration(event.target.value)}
                      />
                    </label>
                  )}
                </>
              )}
              {durationInvalid && (
                <p className="error" id="duration-error" role="alert">
                  请输入有效的非负分钟数，或清空表示未知。
                </p>
              )}
            </>
          )}
          {e.kind === "symptom" && (
            <>
              <DiscomfortFields
                value={e.discomfort}
                onChange={(discomfort) =>
                  update({ discomfort } as Partial<SymptomEntry>)
                }
              />
              <label>
                当时的情境
                <input
                  value={e.context}
                  placeholder="例如：饭后、紧张时、没有去厕所"
                  onChange={(event) =>
                    update({
                      context: event.target.value,
                    } as Partial<SymptomEntry>)
                  }
                />
              </label>
            </>
          )}
          {e.kind === "meal" && (
            <>
              <Choices
                label="餐次"
                items={Object.entries(slots) as [MealEntry["slot"], string][]}
                value={e.slot}
                onChange={(slot) => update({ slot } as Partial<MealEntry>)}
              />
              <Choices
                label="这餐吃了吗？"
                items={[
                  ["eaten", "吃了"],
                  ["skipped", "没吃"],
                ]}
                value={e.status}
                onChange={(status) =>
                  update({
                    status,
                    ...(status === "skipped"
                      ? { foods: "", tags: [], portion: "unknown" }
                      : {}),
                  } as Partial<MealEntry>)
                }
              />
              {e.status === "eaten" && (
                <>
                  <label>
                    吃了什么、喝了什么？
                    <textarea
                      value={e.foods}
                      placeholder="保留具体食物，标签作为补充。"
                      onChange={(event) =>
                        update({
                          foods: event.target.value,
                        } as Partial<MealEntry>)
                      }
                    />
                  </label>
                  {snapshot.settings.foodTemplates.length > 0 && (
                    <fieldset className="choice-field">
                      <legend>常用组合 · 只填入，不直接保存</legend>
                      <div className="choices">
                        {snapshot.settings.foodTemplates.map((f, i) => (
                          <button
                            type="button"
                            key={i}
                            onClick={() =>
                              update({ foods: f } as Partial<MealEntry>)
                            }
                          >
                            {f}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  )}
                  <Choices
                    label="特征标签（可选）"
                    items={[
                      "奶",
                      "咖啡",
                      "辣",
                      "酒",
                      "冷饮",
                      "油腻",
                      "其它",
                    ].map((t) => [t, t] as const)}
                    value={e.tags}
                    multi
                    onChange={(tag) =>
                      update({
                        tags: e.tags.includes(tag)
                          ? e.tags.filter((t) => t !== tag)
                          : [...e.tags, tag],
                      } as Partial<MealEntry>)
                    }
                  />
                  <Choices
                    label="份量（可选）"
                    items={[
                      ["unknown", "未记录"],
                      ["small", "少量"],
                      ["medium", "适量"],
                      ["large", "较多"],
                    ]}
                    value={e.portion}
                    onChange={(portion) =>
                      update({ portion } as Partial<MealEntry>)
                    }
                  />
                </>
              )}
            </>
          )}
          <label>
            备注（可选）
            <textarea
              value={e.note}
              onChange={(event) => update({ note: event.target.value })}
            />
          </label>
          <p className="muted" role="status">
            {draftStatus} · 返回保留草稿
          </p>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <button className="primary" type="submit">
              {pending
                ? "正在保存…"
                : draft.editing
                  ? "保存修改"
                  : e.kind === "meal"
                    ? "保存饮食记录"
                    : e.kind === "toilet"
                      ? "保存如厕记录"
                      : "保存症状记录"}
            </button>
            {draft.editing && (
              <button
                className="danger"
                type="button"
                onClick={() => void remove()}
              >
                删除记录
              </button>
            )}
            <button
              type="button"
              className="text-button"
              onClick={() => void discard()}
            >
              丢弃{timer ? "本次计时和" : ""}草稿
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
