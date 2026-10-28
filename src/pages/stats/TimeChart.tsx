import { memo } from "react";
import type { StatsPresentation } from "./statsPresentation";
import { resultNames } from "./statsPresentation";

export const TimeChart = memo(function TimeChart({
  rows,
  onDay,
}: {
  rows: StatsPresentation["rows"];
  onDay: (day: string, trigger: HTMLButtonElement) => void;
}) {
  const long = rows.length > 31;
  return (
    <>
      <div className="stats-section-heading">
        <h2>如厕时点</h2>
        <small>{long ? "按日期列表" : "0—24 时"}</small>
      </div>
      <p className="stats-legend">
        <span>● 有排出</span>
        <span>× 无排出</span>
        <span>? 不确定</span>
        <span>~ 估计时点</span>
      </p>
      {long ? (
        <p className="stats-note">
          超过 31 天，按完整日期列表展示；未隐藏日期。
        </p>
      ) : (
        <div className="stats-axis" aria-hidden="true">
          {[0, 6, 12, 18, 24].map((n) => (
            <span key={n}>{n}</span>
          ))}
        </div>
      )}
      <div
        className={`stats-time-chart${long ? " stats-long-list" : ""}`}
        data-testid="stats-time-chart"
        aria-label="按日期的如厕时点"
      >
        {rows
          .slice()
          .reverse()
          .map((row) => (
            <button
              type="button"
              className="stats-time-row"
              data-testid="stats-day-row"
              data-day={row.day}
              key={row.day}
              onClick={(e) => onDay(row.day, e.currentTarget)}
              style={{ minHeight: row.height }}
              aria-label={`${row.day}，${row.events.length ? `${row.events.length} 条如厕记录` : "如厕未记"}，打开当日列表`}
            >
              <time dateTime={row.day}>
                {long ? row.day : row.day.slice(5).replace("-", "/")}
              </time>
              {long ? (
                <span className="stats-list-events">
                  {row.events.length
                    ? row.events.map((event) => (
                        <span
                          data-testid="stats-time-event"
                          data-entry-id={event.entry.id}
                          data-result={event.entry.result}
                          key={event.entry.id}
                        >
                          {event.time}{" "}
                          {event.entry.result === "passed"
                            ? "●"
                            : event.entry.result === "none"
                              ? "×"
                              : "?"}
                          {event.entry.estimatedTime && <span> ~</span>}
                        </span>
                      ))
                    : "未记"}
                </span>
              ) : (
                <span
                  className="stats-time-track"
                  style={{ height: row.height }}
                >
                  {row.events.length ? (
                    row.events.map((event) => (
                      <i
                        className={`stats-event ${event.entry.result}`}
                        data-testid="stats-time-event"
                        data-entry-id={event.entry.id}
                        data-result={event.entry.result}
                        data-minute={event.minute}
                        data-lane={event.lane}
                        key={event.entry.id}
                        style={{
                          left: `${(event.minute / 1440) * 100}%`,
                          top: 7 + event.lane * 19,
                        }}
                        title={`${event.time} ${resultNames[event.entry.result]}${event.entry.estimatedTime ? "（估计时点）" : ""}`}
                      >
                        <span>
                          {event.entry.result === "passed"
                            ? "●"
                            : event.entry.result === "none"
                              ? "×"
                              : "?"}
                        </span>
                        {event.entry.estimatedTime && <sup>~</sup>}
                      </i>
                    ))
                  ) : (
                    <span className="stats-no-event">未记</span>
                  )}
                </span>
              )}
              <span className="stats-day-count">
                {row.events.length || "—"}
              </span>
            </button>
          ))}
      </div>
      <p className="stats-note">
        整行可打开当日列表；近时点分层，不移动横轴时刻。未记录 ≠ 未如厕。
      </p>
    </>
  );
});
