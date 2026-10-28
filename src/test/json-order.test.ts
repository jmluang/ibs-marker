import { afterEach, expect, it } from "vitest";
import { TrackerStore } from "../state/TrackerStore";
import { IndexedDbAdapter } from "../storage/indexedDb";
import {
  defaultSettings,
  type Entry,
  type RemoteResource,
  type Settings,
  type ToiletEntry,
} from "../domain/types";

const stores: TrackerStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    s.dispose();
    s.adapter.close();
  }
});
async function make() {
  const s = new TrackerStore(
    new IndexedDbAdapter("json-order-" + crypto.randomUUID()),
  );
  stores.push(s);
  await s.activate("local");
  return s;
}
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)]),
    ) as T;
  return value;
}
function entry(): ToiletEntry {
  const at = "2026-10-20T01:00:00Z";
  return {
    id: crypto.randomUUID(),
    kind: "toilet",
    occurredAt: at,
    createdAt: at,
    updatedAt: at,
    estimatedTime: false,
    deletedAt: null,
    note: "",
    result: "passed",
    stoolForms: [3, 4],
    discomfort: {
      status: "reported",
      symptoms: [
        { name: "pain", severity: "mild" },
        { name: "bloating", severity: "moderate" },
      ],
    },
    startedAt: null,
    endedAt: null,
    durationSource: "unknown",
    estimatedDurationMinutes: null,
    relief: "unknown",
  };
}
function remote(snapshot: Entry | Settings, version = 1): RemoteResource {
  return "kind" in snapshot
    ? {
        kind: "entry",
        resourceId: snapshot.id,
        snapshot,
        version,
        tombstone: false,
      }
    : {
        kind: "settings",
        resourceId: "settings",
        snapshot,
        version,
        tombstone: false,
      };
}
it("ACK object and nested key reorder preserves entry editor revision", async () => {
  const s = await make(),
    e = entry();
  await s.saveEntry(e);
  const revision = s.getEditRevision(e.id),
    op = s.pendingOperations()[0];
  await s.acknowledge(
    s.identityToken(),
    op.changeId,
    1,
    remote(reverseKeys(e)),
  );
  expect(s.getEditRevision(e.id)).toBe(revision);
  expect(s.getSnapshot().outbox).toHaveLength(0);
  await expect(
    s.saveEntry({ ...e, note: "editor saved" }, revision),
  ).resolves.toBeUndefined();
});
it("ACK recursively reordered settings preserves settings editor revision", async () => {
  const s = await make(),
    settings = { ...defaultSettings(), foodTemplates: ["rice", "tea"] };
  await s.saveSettings(settings);
  const revision = s.getEditRevision("settings"),
    op = s.pendingOperations()[0];
  const reordered = reverseKeys(settings);
  expect(Object.keys(reordered.meals.breakfast)).not.toEqual(
    Object.keys(settings.meals.breakfast),
  );
  await s.acknowledge(s.identityToken(), op.changeId, 1, remote(reordered));
  expect(s.getEditRevision("settings")).toBe(revision);
  await expect(s.saveSettings(settings, revision)).resolves.toBeUndefined();
});
it.each(["entry", "settings"] as const)(
  "pull key reorder preserves %s editor revision",
  async (kind) => {
    const s = await make(),
      original = kind === "entry" ? entry() : defaultSettings();
    const resource = remote(original);
    await s.applyPull(s.identityToken(), [resource], 1);
    const revision = s.getEditRevision(resource.resourceId);
    await s.applyPull(s.identityToken(), [remote(reverseKeys(original), 2)], 2);
    expect(s.getEditRevision(resource.resourceId)).toBe(revision);
    if (kind === "entry")
      await expect(
        s.saveEntry(original as Entry, revision),
      ).resolves.toBeUndefined();
    else
      await expect(
        s.saveSettings(original as Settings, revision),
      ).resolves.toBeUndefined();
  },
);
it.each(["ACK", "pull"] as const)(
  "%s stool array reorder is a real change and rejects old editor",
  async (path) => {
    const s = await make(),
      e = entry();
    if (path === "ACK") await s.saveEntry(e);
    else await s.applyPull(s.identityToken(), [remote(e)], 1);
    const revision = s.getEditRevision(e.id),
      changed = { ...e, stoolForms: [...e.stoolForms].reverse() };
    if (path === "ACK") {
      const op = s.pendingOperations()[0];
      await s.acknowledge(s.identityToken(), op.changeId, 1, remote(changed));
    } else await s.applyPull(s.identityToken(), [remote(changed, 2)], 2);
    expect(s.getEditRevision(e.id)).toBe(revision + 1);
    await expect(s.saveEntry(e, revision)).rejects.toThrow("STALE_REVISION");
  },
);
it("nested symptom array reorder also invalidates the editor", async () => {
  const s = await make(),
    e = entry();
  await s.applyPull(s.identityToken(), [remote(e)], 1);
  const revision = s.getEditRevision(e.id);
  const changed = {
    ...e,
    discomfort: {
      ...e.discomfort,
      symptoms: [...e.discomfort.symptoms].reverse(),
    },
  } as ToiletEntry;
  await s.applyPull(s.identityToken(), [remote(changed, 2)], 2);
  expect(s.getEditRevision(e.id)).toBe(revision + 1);
  await expect(s.saveEntry(e, revision)).rejects.toThrow("STALE_REVISION");
});
