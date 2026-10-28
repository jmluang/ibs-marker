import type { Entry, ToiletEntry, Settings } from "./types.ts";
import { defaultSettings } from "./types.ts";
const iso = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) &&
  Number.isFinite(Date.parse(v));
export const shanghaiDate = (at: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
export const shanghaiTime = (at: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
export const fromShanghai = (day: string, time: string): string =>
  new Date(`${day}T${time}:00+08:00`).toISOString();
export const sortEntries = (entries: Entry[]) =>
  entries
    .filter((e) => !e.deletedAt)
    .slice()
    .sort(
      (a, b) =>
        Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
        a.id.localeCompare(b.id),
    );
export function validateEntry(e: Entry): string[] {
  const errors: string[] = [];
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      e.id,
    )
  )
    errors.push("id");
  for (const k of ["occurredAt", "createdAt", "updatedAt"] as const)
    if (!iso(e[k])) errors.push(k);
  if (e.deletedAt !== null && !iso(e.deletedAt)) errors.push("deletedAt");
  if (typeof e.estimatedTime !== "boolean" || typeof e.note !== "string")
    errors.push("common");
  if (e.kind === "toilet") {
    if (!["passed", "none", "unsure"].includes(e.result)) errors.push("result");
    if (
      !Array.isArray(e.stoolForms) ||
      e.stoolForms.some((f) => !["unknown", 1, 2, 3, 4, 5, 6, 7].includes(f)) ||
      (e.result === "passed"
        ? e.stoolForms.length === 0
        : e.stoolForms.length !== 0)
    )
      errors.push("stoolForms");
    if (e.startedAt !== null && !iso(e.startedAt)) errors.push("startedAt");
    if (e.endedAt !== null && !iso(e.endedAt)) errors.push("endedAt");
    if (
      e.endedAt &&
      (!e.startedAt || Date.parse(e.endedAt) < Date.parse(e.startedAt))
    )
      errors.push("duration order");
    if (
      e.durationSource === "timer" &&
      (!e.startedAt || !e.endedAt || e.estimatedDurationMinutes !== null)
    )
      errors.push("timer duration");
    if (
      e.durationSource === "estimated" &&
      (e.estimatedDurationMinutes === null ||
        !Number.isFinite(e.estimatedDurationMinutes) ||
        e.estimatedDurationMinutes < 0)
    )
      errors.push("estimated duration");
    if (e.durationSource === "unknown" && e.estimatedDurationMinutes !== null)
      errors.push("unknown duration");
    if (!["timer", "estimated", "unknown"].includes(e.durationSource))
      errors.push("durationSource");
    if (!["yes", "partial", "no", "unknown"].includes(e.relief))
      errors.push("relief");
  }
  if (e.kind === "toilet" || e.kind === "symptom") {
    const d = e.discomfort;
    if (
      !d ||
      !["reported", "none", "unknown"].includes(d.status) ||
      !Array.isArray(d.symptoms) ||
      (d.status === "reported"
        ? d.symptoms.length === 0
        : d.symptoms.length !== 0)
    )
      errors.push("discomfort");
    else if (
      d.symptoms.some(
        (s) =>
          !["pain", "bloating", "urgency", "nausea", "other"].includes(
            s.name,
          ) || !["mild", "moderate", "severe", "unknown"].includes(s.severity),
      )
    )
      errors.push("symptoms");
  }
  if (e.kind === "meal") {
    if (
      !["eaten", "skipped"].includes(e.status) ||
      !["breakfast", "lunch", "dinner", "snack"].includes(e.slot) ||
      typeof e.foods !== "string" ||
      !Array.isArray(e.tags) ||
      !["small", "medium", "large", "unknown"].includes(e.portion)
    )
      errors.push("meal");
    if (
      e.status === "skipped" &&
      (e.foods.trim() || e.tags.length || e.portion !== "unknown")
    )
      errors.push("skipped foods");
  }
  if (!["meal", "toilet", "symptom"].includes(e.kind)) errors.push("kind");
  return errors;
}
export function validateSettings(s: Settings): string[] {
  const errors: string[] = [];
  for (const slot of ["breakfast", "lunch", "dinner"] as const) {
    const m = s.meals?.[slot];
    if (
      !m ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(m.time) ||
      typeof m.enabled !== "boolean"
    )
      errors.push(slot);
  }
  if (
    !Array.isArray(s.foodTemplates) ||
    s.foodTemplates.some((f) => typeof f !== "string")
  )
    errors.push("foodTemplates");
  if (typeof s.remindersEnabled !== "boolean") errors.push("remindersEnabled");
  for (const [key, time] of Object.entries(s.snoozes ?? {}))
    if (!/^\d{4}-\d{2}-\d{2}:(breakfast|lunch|dinner)$/.test(key) || !iso(time))
      errors.push("snooze");
  return errors;
}
export const durationMinutes = (e: ToiletEntry): number | null =>
  e.durationSource === "estimated"
    ? e.estimatedDurationMinutes
    : e.durationSource === "timer" && e.startedAt && e.endedAt
      ? Math.max(0, (Date.parse(e.endedAt) - Date.parse(e.startedAt)) / 60000)
      : null;
export const lastPassed = (entries: Entry[]): ToiletEntry | undefined =>
  sortEntries(entries).find(
    (e): e is ToiletEntry => e.kind === "toilet" && e.result === "passed",
  );
export function statistics(entries: Entry[]) {
  const all = entries.filter((e) => !e.deletedAt);
  const toilets = all.filter((e): e is ToiletEntry => e.kind === "toilet");
  const discomfort = all
    .filter((e) => e.kind === "toilet" || e.kind === "symptom")
    .map((e) => e.discomfort);
  const durations = toilets
    .map(durationMinutes)
    .filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0);
  const forms: Record<string, number> = {
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    "5": 0,
    "6": 0,
    "7": 0,
    unknown: 0,
  };
  for (const e of toilets)
    if (e.result === "passed") for (const f of e.stoolForms) forms[f]++;
  const reported = discomfort.filter((d) => d.status === "reported").length,
    known = discomfort.filter((d) => d.status !== "unknown").length;
  return {
    toiletCount: toilets.length,
    passedCount: toilets.filter((e) => e.result === "passed").length,
    stoolForms: forms,
    stoolKnownSegments: Object.entries(forms)
      .filter(([k]) => k !== "unknown")
      .reduce((s, [, v]) => s + v, 0),
    discomfortReported: reported,
    discomfortKnown: known,
    discomfortUnknown: discomfort.length - known,
    discomfortRatio: known ? reported / known : null,
    durationKnown: durations.length,
    durationMissing: toilets.length - durations.length,
    averageDurationMinutes: durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null,
  };
}
export function completeness(
  entries: Entry[],
  day: string,
  settings: Settings = defaultSettings(),
) {
  const all = entries.filter(
    (e) => !e.deletedAt && shanghaiDate(e.occurredAt) === day,
  );
  const enabled = (["breakfast", "lunch", "dinner"] as const).filter(
    (s) => settings.meals[s].enabled,
  );
  const missing: string[] = [];
  let confirmed = 0,
    expected = 0;
  for (const e of all) {
    if (e.kind === "toilet") {
      expected += 2;
      if (e.result !== "unsure") confirmed++;
      else missing.push(`${e.id}:result`);
      if (e.discomfort.status !== "unknown") confirmed++;
      else missing.push(`${e.id}:discomfort`);
    }
    if (e.kind === "symptom") {
      expected++;
      if (e.discomfort.status !== "unknown") confirmed++;
      else missing.push(`${e.id}:discomfort`);
    }
  }
  const meals = enabled.filter((s) =>
    all.some((e) => e.kind === "meal" && e.slot === s),
  );
  for (const s of enabled) if (!meals.includes(s)) missing.push(`meal:${s}`);
  return {
    mealsConfirmed: meals.length,
    mealsEnabled: enabled.length,
    eventConfirmed: confirmed,
    eventExpected: expected,
    missing,
  };
}
export const exportJson = (entries: Entry[], settings?: Settings) =>
  JSON.stringify({ schemaVersion: 1, entries, settings }, null, 2);
const cell = (v: unknown) => {
  let s =
    v === null || v === undefined
      ? ""
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
  if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
};
export function exportCsv(entries: Entry[]): string {
  const keys = [
    "id",
    "kind",
    "occurredAt",
    "createdAt",
    "updatedAt",
    "estimatedTime",
    "deletedAt",
    "result",
    "stoolForms",
    "discomfort",
    "startedAt",
    "endedAt",
    "durationSource",
    "estimatedDurationMinutes",
    "relief",
    "status",
    "slot",
    "foods",
    "tags",
    "portion",
    "context",
    "note",
  ];
  return (
    "\uFEFF" +
    [
      keys.map(cell).join(","),
      ...sortEntries(entries).map((e) =>
        keys
          .map((k) => cell((e as unknown as Record<string, unknown>)[k]))
          .join(","),
      ),
    ].join("\r\n")
  );
}
