import { readFileSync } from "node:fs";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyData, type TrackerSnapshot } from "../domain/types";
import { newEntry } from "../components/EntryForm";

const state = vi.hoisted(() => ({ snapshot: null as unknown as TrackerSnapshot, start: vi.fn() }));
vi.mock("../state/useTracker", () => ({ useTracker: () => state.snapshot }));
vi.mock("../state/TrackerStore", () => ({ trackerStore: { startTimer: state.start } }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useEffect: () => {}, useRef: (value: unknown) => ({ current: value }),
    useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, vi.fn()] };
});
import App from "../App";
import { Timeline } from "../components/ui";

function nodes(node: ReactNode): { type: unknown; props: Record<string, any> }[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  const element = { type: node.type, props: node.props };
  if (typeof node.type === "function" && /^(TodayPageView|HistoryPageView|Timeline|Choices)$/.test(node.type.name))
    return [element, ...nodes((node.type as (props: any) => ReactNode)(node.props))];
  return [element, ...nodes(node.props.children)];
}
const text = (node: ReactNode): string => {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<Record<string, any>>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
};
function appNodes() { return nodes(App({ privateMode: false })); }
function button(label: RegExp) { return appNodes().find(n => n.type === "button" && label.test(text(n.props.children)))!; }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T05:00:00Z"));
  vi.stubGlobal("location", { hash: "#today" });
  vi.stubGlobal("window", { location: globalThis.location });
  state.snapshot = { ...emptyData(), namespace: "local", generation: 3, loading: false, error: null, entries: [], syncStatus: { state: "idle" } };
  state.start.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("compact watercolor real home and history", () => {
  it("separates backfill from present-time action and invokes their real routes", async () => {
    const all = appNodes();
    expect(all.some(n => n.props["data-testid"] === "watercolor-home")).toBe(true);
    const hero = all.find(n => String(n.props.className).split(" ").includes("last-card"))!;
    expect(text(hero.props.children)).not.toMatch(/补记/);
    const heading = all.find(n => n.props.className === "timeline-heading")!;
    expect(text(heading.props.children)).toContain("补记如厕");
    button(/补记如厕/).props.onClick();
    expect(location.hash).toBe("new/toilet"); expect(state.start).not.toHaveBeenCalled();
    location.hash = "today";
    state.start.mockResolvedValue({ id: "timer", endedAt: null });
    await button(/开始如厕/).props.onClick();
    await Promise.resolve(); await Promise.resolve();
    expect(state.start).toHaveBeenCalledOnce(); expect(location.hash).toBe("timer");
  });
  it("backfill never changes an active timer and continue uses the existing timer", () => {
    state.snapshot.timer = { id: "timer", startedAt: "2026-10-23T04:50:00Z", endedAt: null, draft: null };
    const original = state.snapshot.timer;
    button(/补记如厕/).props.onClick(); expect(state.snapshot.timer).toBe(original); expect(state.start).not.toHaveBeenCalled();
    location.hash = "today"; button(/计时中/).props.onClick(); expect(location.hash).toBe("timer");
    location.hash = "today"; state.snapshot.timer = { ...original, endedAt: "2026-10-23T04:55:00Z" };
    button(/继续填写/).props.onClick(); expect(location.hash).toBe("timer-form"); expect(state.start).not.toHaveBeenCalled();
  });
  it("keeps genuine meal reminder/edit actions and unknown meals distinct from skipped", () => {
    button(/^早餐/).props.onClick(); expect(location.hash).toBe("meal-reminder/breakfast");
    location.hash = "today";
    const meal = { ...newEntry("meal", "breakfast"), id: "meal-real", occurredAt: "2026-10-23T00:00:00Z" };
    state.snapshot.entries = [meal];
    button(/^早餐/).props.onClick(); expect(location.hash).toBe("edit/meal-real");
    const markup = renderToStaticMarkup(createElement(App, { privateMode: false }));
    expect(markup).not.toContain("明确没吃"); expect(markup).not.toContain("示例数据");
  });
  it("uses concise history title and retains safe empty-date handling and real edit routing", () => {
    location.hash = "#history";
    const markup = renderToStaticMarkup(createElement(App, { privateMode: false }));
    expect(markup).toContain('data-testid="watercolor-history"');
    expect(markup).toContain("<h1>历史</h1>"); expect(markup).not.toContain("历史记录</h1>");
    const source = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    expect(source).toContain('isValidDay(day) ? day : today()');
    expect(source).toContain('go(`edit/${e.id}`)');
  });
  it("maps actual sync state into user language without claiming idle is synchronized", () => {
    state.snapshot.namespace = "user:test";
    const markup = renderToStaticMarkup(createElement(App, { privateMode: false }));
    expect(markup).not.toContain("idle"); expect(markup).not.toContain("已同步");
    expect(markup).toContain("等待同步");
    state.snapshot.syncStatus = { state: "offline" };
    expect(renderToStaticMarkup(createElement(App, { privateMode: false }))).toContain("离线");
  });
  it("remounts statistics on identity generation and preserves its frozen props", () => {
    const source = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/<StatsPage\s+key=\{snapshot.generation\}\s+entries=\{snapshot.entries\}\s+settings=\{snapshot.settings\}/);
  });
  it("sorts the visual timeline without mutating input and retains unknown, estimate and notes", () => {
    const early = { ...newEntry("toilet"), id: "early", occurredAt: "2026-10-23T00:00:00Z", estimatedTime: true, note: "真实备注" };
    const late = { ...newEntry("symptom"), id: "late", occurredAt: "2026-10-23T02:00:00Z" };
    const entries = [early, late]; const edit = vi.fn();
    const tree = Timeline({ entries, onEdit: edit });
    const buttons = nodes(tree).filter(n => n.type === "button");
    expect(text(buttons[0].props.children)).toContain("10:00");
    buttons[0].props.onClick(); expect(edit).toHaveBeenCalledWith(late);
    expect(entries.map(e => e.id)).toEqual(["early", "late"]);
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain("不适未记录"); expect(markup).toContain("时长未知");
    expect(markup).toContain("估计"); expect(markup).toContain("真实备注");
  });
});
