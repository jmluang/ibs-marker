import { useState } from "react";
import { StatsModal } from "./StatsModal";
import {
  dateRangeError,
  presetRange,
  type StatsRange,
} from "./statsPresentation";

export default function RangeDialog({
  value,
  onCancel,
  onConfirm,
  onReady,
}: {
  value: StatsRange;
  onCancel: () => void;
  onConfirm: (range: StatsRange) => void;
  onReady: (release: () => void) => void;
}) {
  const [draft, setDraft] = useState(() => ({ ...value }));
  const [today] = useState(() => presetRange("7").to);
  const bounds =
    draft.kind === "custom" ? draft : presetRange(draft.kind, today);
  const error = dateRangeError(bounds.from, bounds.to);
  return (
    <StatsModal
      label="选择范围"
      testId="stats-range-dialog"
      onCancel={onCancel}
      onReady={onReady}
    >
      <div className="stats-modal-handle" aria-hidden="true" />
      <header className="stats-modal-heading">
        <h2>选择范围</h2>
        <button
          type="button"
          data-testid="stats-range-close"
          onClick={onCancel}
          aria-label="关闭范围选择"
        >
          ×
        </button>
      </header>
      <div className="stats-range-options">
        {(["7", "30", "custom"] as const).map((kind) => {
          const dates = kind === "custom" ? draft : presetRange(kind, today);
          return (
            <button
              type="button"
              data-testid={`stats-range-option-${kind}`}
              key={kind}
              aria-pressed={draft.kind === kind}
              onClick={() => setDraft((previous) => ({ ...previous, kind }))}
            >
              <span>
                {kind === "custom" ? "自定义" : `${kind}天`}
                <small>
                  {dates.from || "未选择"} 至 {dates.to || "未选择"}
                </small>
              </span>
              <i aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {draft.kind === "custom" && (
        <div className="stats-range-dates">
          <label>
            开始
            <input
              data-testid="stats-range-from"
              aria-label="开始日期"
              type="date"
              value={draft.from}
              onChange={(e) =>
                setDraft((previous) => ({ ...previous, from: e.target.value }))
              }
            />
          </label>
          <label>
            结束
            <input
              data-testid="stats-range-to"
              aria-label="结束日期"
              type="date"
              value={draft.to}
              onChange={(e) =>
                setDraft((previous) => ({ ...previous, to: e.target.value }))
              }
            />
          </label>
        </div>
      )}
      {error && (
        <p role="alert" className="stats-range-error">
          {error}
        </p>
      )}
      <div className="stats-range-actions">
        <button
          type="button"
          data-testid="stats-range-cancel"
          onClick={onCancel}
        >
          取消
        </button>
        <button
          type="button"
          className="stats-range-apply"
          data-testid="stats-range-confirm"
          disabled={!!error}
          onClick={() => {
            if (!error) onConfirm({ ...bounds });
          }}
        >
          确认范围
        </button>
      </div>
      <p className="stats-range-note">确认后应用，取消保留当前范围</p>
    </StatsModal>
  );
}
