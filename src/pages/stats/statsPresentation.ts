import type { Entry, MealEntry, ToiletEntry } from "../../domain/types";
import {
  durationMinutes,
  shanghaiDate,
  shanghaiTime,
  statistics,
} from "../../domain/helpers";

export type RangeKind = "7" | "30" | "custom";
export interface StatsRange {
  kind: RangeKind;
  from: string;
  to: string;
}
export function isValidDay(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day.startsWith("0000")) return false;
  const d = new Date(`${day}T12:00:00+08:00`);
  return (
    Number.isFinite(d.getTime()) &&
    shanghaiDate(d.toISOString()).padStart(10, "0") === day
  );
}
export function addDay(day: string, n: number) {
  if (!isValidDay(day) || !Number.isSafeInteger(n)) return "";
  const date = new Date(`${day}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + n);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() < 1 ||
    date.getUTCFullYear() > 9999
  )
    return "";
  const result = shanghaiDate(date.toISOString()).padStart(10, "0");
  return isValidDay(result) ? result : "";
}
export function dateRangeError(from: string, to: string) {
  if (!from || !to) return "请填写开始和结束日期，或选择 7 天 / 30 天。";
  if (!isValidDay(from) || !isValidDay(to))
    return "请选择有效日期，或选择 7 天 / 30 天。";
  if (from > to) return "开始日期不能晚于结束日期，请调整日期。";
  if (
    (Date.parse(`${to}T12:00:00+08:00`) -
      Date.parse(`${from}T12:00:00+08:00`)) /
      86400000 >=
    366
  )
    return "自定义范围最多 366 天（含开始和结束日期）。";
  return "";
}
export function presetRange(
  kind: "7" | "30",
  today = shanghaiDate(new Date().toISOString()),
): StatsRange {
  return { kind, from: addDay(today, 1 - Number(kind)), to: today };
}
export const resultNames = {
  passed: "有排出",
  none: "无排出",
  unsure: "不确定",
};
export function layoutEvents(entries: ToiletEntry[]) {
  const ends: number[] = [];
  const events = entries
    .slice()
    .sort(
      (a, b) =>
        Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
        a.id.localeCompare(b.id),
    )
    .map((entry) => {
      const time = shanghaiTime(entry.occurredAt);
      const [hour, minutePart] = time.split(":").map(Number);
      const minute = hour * 60 + minutePart;
      let lane = ends.findIndex((end) => minute - end >= 110);
      if (lane < 0) lane = ends.length;
      ends[lane] = minute;
      return { entry, time, minute, lane };
    });
  return { events, height: Math.max(44, ends.length * 19 + 12) };
}
export function buildStatsPresentation(
  entries: Entry[],
  from: string,
  to: string,
) {
  const range: Entry[] = [];
  const byDay = new Map<string, Entry[]>();
  const meals = new Map<string, Map<string, MealEntry[]>>();
  if (!dateRangeError(from, to))
    for (const entry of entries) {
      if (entry.deletedAt) continue;
      const day = shanghaiDate(entry.occurredAt);
      if (day < from || day > to) continue;
      range.push(entry);
      const list = byDay.get(day) ?? [];
      list.push(entry);
      byDay.set(day, list);
      if (entry.kind === "meal") {
        const slots = meals.get(day) ?? new Map<string, MealEntry[]>();
        const slot = slots.get(entry.slot) ?? [];
        slot.push(entry);
        slots.set(entry.slot, slot);
        meals.set(day, slots);
      }
    }
  for (const list of byDay.values())
    list.sort(
      (a, b) =>
        Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
        a.id.localeCompare(b.id),
    );
  const days: string[] = [];
  if (!dateRangeError(from, to))
    for (let day = from; day && day <= to; day = addDay(day, 1)) days.push(day);
  const toilets = range.filter((e): e is ToiletEntry => e.kind === "toilet");
  const rows = days.map((day) => ({
    day,
    ...layoutEvents(
      (byDay.get(day) ?? []).filter(
        (e): e is ToiletEntry => e.kind === "toilet",
      ),
    ),
  }));
  // Keep the domain helpers authoritative; explicit known-duration values also serve the data notes.
  const durations = toilets
    .map(durationMinutes)
    .filter((n): n is number => n !== null && Number.isFinite(n) && n >= 0);
  return {
    entries: range,
    byDay,
    days,
    rows,
    meals,
    stats: statistics(range),
    durations,
    shapeMissing: toilets.filter(
      (e) => e.result === "passed" && e.stoolForms.length === 0,
    ).length,
  };
}
export type StatsPresentation = ReturnType<typeof buildStatsPresentation>;
