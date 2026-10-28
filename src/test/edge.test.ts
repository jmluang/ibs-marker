import { it, expect } from "vitest";
import { TrackerStore } from "../state/TrackerStore";
import { IndexedDbAdapter } from "../storage/indexedDb";
import {
  statistics,
  completeness,
  validateEntry,
  fromShanghai,
} from "../domain/helpers";
import {
  defaultSettings,
  type MealEntry,
  type NamespaceData,
} from "../domain/types";
const now = "2026-10-20T01:00:00Z";
const meal = (changes: Partial<MealEntry> = {}): MealEntry => ({
  id: crypto.randomUUID(),
  kind: "meal",
  occurredAt: now,
  createdAt: now,
  updatedAt: now,
  estimatedTime: false,
  deletedAt: null,
  note: "",
  status: "eaten",
  slot: "breakfast",
  foods: "粥、鸡蛋",
  tags: [],
  portion: "medium",
  ...changes,
});
const make = () =>
  new TrackerStore(new IndexedDbAdapter("edge-" + crypto.randomUUID()));
it("rejects stale asynchronous reload after newer committed write", async () => {
  const s = make();
  await s.activate("local");
  const original = s.adapter.read.bind(s.adapter);
  let release!: (d: NamespaceData) => void;
  const old = await original("local");
  s.adapter.read = () =>
    new Promise((r) => {
      release = r;
    });
  const read = s.reload();
  await s.saveEntry(meal());
  release(old);
  await read;
  expect(s.getSnapshot().entries).toHaveLength(1);
  s.adapter.read = original;
  s.dispose();
});
it("regular meal uniqueness permits editing, deletion and unlimited snacks", async () => {
  const s = make();
  await s.activate("local");
  const e = meal();
  await s.saveEntry(e);
  await expect(s.saveEntry(meal())).rejects.toThrow("MEAL_SLOT_EXISTS");
  await s.saveEntry({ ...e, status: "skipped", foods: "", portion: "unknown" });
  await s.saveEntry(meal({ slot: "snack" }));
  await s.saveEntry(meal({ slot: "snack" }));
  await s.deleteEntry(e.id);
  await s.saveEntry(meal());
  expect(s.getSnapshot().entries).toHaveLength(3);
  s.dispose();
});
it("rolls back entire pull plus cursor on transaction failure", async () => {
  const s = make();
  await s.activate("local");
  (s.adapter as IndexedDbAdapter).failNextWrite = true;
  const e = meal();
  await expect(
    s.applyPull(
      s.identityToken(),
      [
        {
          kind: "entry",
          resourceId: e.id,
          version: 1,
          snapshot: e,
          tombstone: false,
        },
      ],
      7,
    ),
  ).rejects.toThrow();
  await s.reload();
  expect(s.getSnapshot().cursor).toBe(0);
  expect(s.getSnapshot().entries).toHaveLength(0);
  s.dispose();
});
it("pull records conflict without replacing dirty settings", async () => {
  const s = make();
  await s.activate("local");
  await s.saveSettings({ ...defaultSettings(), foodTemplates: ["本地"] });
  await s.applyPull(
    s.identityToken(),
    [
      {
        kind: "settings",
        resourceId: "settings",
        version: 2,
        snapshot: { ...defaultSettings(), foodTemplates: ["远端"] },
        tombstone: false,
      },
    ],
    3,
  );
  expect(s.getSnapshot().conflicts).toHaveLength(1);
  expect(s.getSnapshot().settings.foodTemplates).toEqual(["本地"]);
  await s.resolveConflict("settings", "retry-settings");
  expect(s.getSnapshot().outbox[0].baseVersion).toBe(2);
  expect(s.getSnapshot().conflicts).toHaveLength(0);
  s.dispose();
});
it("logout clears visible drafts timer settings and rejects old acknowledgements", async () => {
  const s = make();
  await s.activate("local");
  await s.saveEntry(meal());
  await s.startTimer(now);
  await s.saveDraft("private", "content");
  const t = s.identityToken(),
    op = s.pendingOperations()[0];
  await s.activate(null);
  expect(s.getSnapshot().entries).toEqual([]);
  expect(s.getSnapshot().timer).toBeNull();
  expect(s.getSnapshot().drafts).toEqual({});
  expect(await s.acknowledge(t, op.changeId, 1)).toBe(false);
  s.dispose();
});
it("clear cancellation is non-destructive", async () => {
  const s = make();
  await s.activate("local");
  await s.saveEntry(meal());
  await expect(s.clearCurrentNamespace(false)).rejects.toThrow(
    "CONFIRM_REQUIRED",
  );
  expect(s.getSnapshot().outbox).toHaveLength(1);
  s.dispose();
});
it("reports empty unknown metrics and explicit enabled meal denominator", () => {
  expect(statistics([]).discomfortRatio).toBeNull();
  expect(fromShanghai("2026-10-20", "01:00")).toBe("2026-10-19T17:00:00.000Z");
  const settings = defaultSettings();
  settings.meals.dinner.enabled = false;
  expect(completeness([meal()], "2026-10-20", settings)).toMatchObject({
    mealsConfirmed: 1,
    mealsEnabled: 2,
  });
  expect(validateEntry(meal({ status: "skipped" }))).not.toEqual([]);
});
