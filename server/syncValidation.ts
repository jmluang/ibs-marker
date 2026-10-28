import type {
  Entry,
  Settings,
  OutboxOperation,
  RemoteResource,
} from "../src/domain/types.ts";
import { validateEntry, validateSettings } from "../src/domain/helpers.ts";
export const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
function invalid(): never {
  throw new Error("INVALID_OPERATION");
}
export function exact(
  v: unknown,
  keys: readonly string[],
): asserts v is Record<string, unknown> {
  if (
    !record(v) ||
    Object.keys(v).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(v, k))
  )
    invalid();
}
const text = (v: unknown): v is string =>
  typeof v === "string" && Buffer.byteLength(v) <= 262144;
const bool = (v: unknown) => typeof v === "boolean";
const iso = (v: unknown): v is string => {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
      v,
    ) ||
    !Number.isFinite(Date.parse(v))
  )
    return false;
  // Date.parse normalizes February 30 instead of rejecting it.
  const day = v.slice(0, 10);
  const midnight = Date.parse(day + "T00:00:00.000Z");
  return (
    Number.isFinite(midnight) &&
    new Date(midnight).toISOString().slice(0, 10) === day
  );
};
const nullableDate = (v: unknown) => v === null || iso(v);
function array(v: unknown): asserts v is unknown[] {
  if (!Array.isArray(v) || v.length > 1000) invalid();
}
function strings(v: unknown) {
  array(v);
  if (!v.every(text)) invalid();
}
function discomfort(v: unknown) {
  exact(v, ["status", "symptoms"]);
  if (!["reported", "none", "unknown"].includes(v.status as string)) invalid();
  array(v.symptoms);
  for (const s of v.symptoms) {
    exact(s, ["name", "severity"]);
    if (
      !["pain", "bloating", "urgency", "nausea", "other"].includes(
        s.name as string,
      ) ||
      !["mild", "moderate", "severe", "unknown"].includes(s.severity as string)
    )
      invalid();
  }
  if (
    v.status === "reported" ? v.symptoms.length === 0 : v.symptoms.length !== 0
  )
    invalid();
}
function entry(v: unknown): Entry {
  if (!record(v)) invalid();
  const common = [
    "id",
    "kind",
    "occurredAt",
    "createdAt",
    "updatedAt",
    "estimatedTime",
    "deletedAt",
    "note",
  ];
  if (v.kind === "toilet") {
    exact(v, [
      ...common,
      "result",
      "stoolForms",
      "discomfort",
      "startedAt",
      "endedAt",
      "durationSource",
      "estimatedDurationMinutes",
      "relief",
    ]);
    array(v.stoolForms);
    if (
      !["passed", "none", "unsure"].includes(v.result as string) ||
      !["timer", "estimated", "unknown"].includes(v.durationSource as string) ||
      !["yes", "partial", "no", "unknown"].includes(v.relief as string) ||
      !v.stoolForms.every((f) =>
        ["unknown", 1, 2, 3, 4, 5, 6, 7].includes(f as never),
      ) ||
      !nullableDate(v.startedAt) ||
      !nullableDate(v.endedAt) ||
      (v.estimatedDurationMinutes !== null &&
        (typeof v.estimatedDurationMinutes !== "number" ||
          !Number.isFinite(v.estimatedDurationMinutes) ||
          v.estimatedDurationMinutes < 0))
    )
      invalid();
    discomfort(v.discomfort);
  } else if (v.kind === "meal") {
    exact(v, [...common, "status", "slot", "foods", "tags", "portion"]);
    if (
      !text(v.foods) ||
      !["eaten", "skipped"].includes(v.status as string) ||
      !["breakfast", "lunch", "dinner", "snack"].includes(v.slot as string) ||
      !["small", "medium", "large", "unknown"].includes(v.portion as string)
    )
      invalid();
    strings(v.tags);
  } else if (v.kind === "symptom") {
    exact(v, [...common, "discomfort", "context"]);
    discomfort(v.discomfort);
    if (!text(v.context)) invalid();
  } else invalid();
  if (
    !uuid(v.id) ||
    !iso(v.occurredAt) ||
    !iso(v.createdAt) ||
    !iso(v.updatedAt) ||
    !nullableDate(v.deletedAt) ||
    !bool(v.estimatedTime) ||
    !text(v.note)
  )
    invalid();
  const e = v as unknown as Entry;
  if (validateEntry(e).length) invalid();
  return structuredClone(e);
}
function settings(v: unknown): Settings {
  exact(v, ["meals", "foodTemplates", "snoozes", "remindersEnabled"]);
  exact(v.meals, ["breakfast", "lunch", "dinner"]);
  for (const slot of ["breakfast", "lunch", "dinner"]) {
    const m = v.meals[slot];
    exact(m, ["time", "enabled"]);
    if (
      typeof m.time !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(m.time) ||
      !bool(m.enabled)
    )
      invalid();
  }
  strings(v.foodTemplates);
  if (
    !bool(v.remindersEnabled) ||
    !record(v.snoozes) ||
    Object.keys(v.snoozes).length > 1000
  )
    invalid();
  for (const [k, t] of Object.entries(v.snoozes))
    if (!/^\d{4}-\d{2}-\d{2}:(breakfast|lunch|dinner)$/.test(k) || !iso(t))
      invalid();
  const s = v as unknown as Settings;
  if (validateSettings(s).length) invalid();
  return structuredClone(s);
}
function resource(v: Record<string, unknown>) {
  if (!bool(v.tombstone)) invalid();
  if (v.kind === "entry") {
    if (!uuid(v.resourceId)) invalid();
    const snapshot = entry(v.snapshot);
    if (
      v.resourceId !== snapshot.id ||
      v.tombstone !== (snapshot.deletedAt !== null)
    )
      invalid();
    return snapshot;
  }
  if (v.kind === "settings") {
    if (v.resourceId !== "settings" || v.tombstone !== false) invalid();
    return settings(v.snapshot);
  }
  return invalid();
}
export function canonicalOperation(v: unknown): OutboxOperation {
  exact(v, [
    "kind",
    "resourceId",
    "changeId",
    "baseVersion",
    "snapshot",
    "tombstone",
  ]);
  if (
    !uuid(v.changeId) ||
    !Number.isSafeInteger(v.baseVersion) ||
    (v.baseVersion as number) < 0
  )
    invalid();
  const snapshot = resource(v);
  return {
    kind: v.kind as OutboxOperation["kind"],
    resourceId: v.resourceId as string,
    changeId: v.changeId,
    baseVersion: v.baseVersion as number,
    snapshot,
    tombstone: v.tombstone as boolean,
  };
}
/** Provider output is reconstructed too: never forward unknown columns/metadata. */
export function canonicalRemote(v: unknown): RemoteResource {
  exact(v, ["kind", "resourceId", "version", "snapshot", "tombstone"]);
  if (!Number.isSafeInteger(v.version) || (v.version as number) < 1) invalid();
  const snapshot = resource(v);
  return {
    kind: v.kind as RemoteResource["kind"],
    resourceId: v.resourceId as string,
    version: v.version as number,
    snapshot,
    tombstone: v.tombstone as boolean,
  };
}
