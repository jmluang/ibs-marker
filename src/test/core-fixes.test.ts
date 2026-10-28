import { afterEach, describe, expect, it } from "vitest";
import { TrackerStore } from "../state/TrackerStore";
import { IndexedDbAdapter } from "../storage/indexedDb";
import {
  defaultSettings,
  type MealEntry,
  type RemoteResource,
} from "../domain/types";
const at = "2026-10-20T01:00:00Z";
const meal = (p: Partial<MealEntry> = {}): MealEntry => ({
  id: crypto.randomUUID(),
  kind: "meal",
  occurredAt: at,
  createdAt: at,
  updatedAt: at,
  estimatedTime: false,
  deletedAt: null,
  note: "",
  status: "eaten",
  slot: "snack",
  foods: "rice",
  tags: [],
  portion: "medium",
  ...p,
});
const remote = (e: MealEntry, version = 2): RemoteResource => ({
  kind: "entry",
  resourceId: e.id,
  version,
  snapshot: e,
  tombstone: !!e.deletedAt,
});
const stores: TrackerStore[] = [];
async function make() {
  const s = new TrackerStore(
    new IndexedDbAdapter("fix-" + crypto.randomUUID()),
  );
  stores.push(s);
  await s.activate("local");
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) {
    s.dispose();
    s.adapter.close();
  }
});
async function entryConflict() {
  const s = await make(),
    e = meal();
  await s.saveEntry(e);
  await s.applyPull(s.identityToken(), [remote({ ...e, note: "remote" })], 1);
  return { s, e };
}
describe("P1 edit revisions", () => {
  it("autosave and timer metadata do not invalidate an open editor", async () => {
    const s = await make(),
      e = meal();
    await s.saveEntry(e);
    const rev = s.getEditRevision(e.id);
    await s.saveDraft("edit", e);
    await s.startTimer(at);
    await s.finishTimer(at);
    await s.saveTimerDraft({ note: "draft" });
    await s.saveEntry({ ...e, note: "saved" }, rev);
    expect(s.getSnapshot().records[e.id].note).toBe("saved");
  });
  it("another tab changing the same record rejects the old editor", async () => {
    const s = await make(),
      e = meal();
    await s.saveEntry(e);
    const rev = s.getEditRevision(e.id);
    const b = new TrackerStore(s.adapter);
    stores.push(b);
    await b.activate("local");
    await b.saveEntry({ ...e, note: "other tab" });
    await expect(s.saveEntry({ ...e, note: "stale" }, rev)).rejects.toThrow(
      "STALE_REVISION",
    );
  });
  it("settings editor survives autosave and rejects concurrent settings changes", async () => {
    const s = await make(),
      rev = s.getEditRevision("settings");
    await s.saveDraft("settings", {});
    await s.saveSettings(
      { ...defaultSettings(), foodTemplates: ["first"] },
      rev,
    );
    await expect(s.saveSettings(defaultSettings(), rev)).rejects.toThrow(
      "STALE_REVISION",
    );
  });
  it("actual pulled content advances only its resource edit revision", async () => {
    const s = await make(),
      e = meal(),
      rev = s.getEditRevision(e.id);
    await s.applyPull(s.identityToken(), [remote(e)], 1);
    expect(s.getEditRevision(e.id)).toBeGreaterThan(rev);
    expect(s.getEditRevision("settings")).toBe(0);
    await expect(s.deleteEntry(e.id, rev)).rejects.toThrow("STALE_REVISION");
  });
  it("reads legacy IDB v1 data without editRevisions and persists the addition", async () => {
    const s = await make(),
      e = meal();
    await s.saveEntry(e);
    await s.adapter.transact("local", (d) => {
      delete (d as Partial<typeof d>).editRevisions;
    });
    await s.reload();
    expect(s.getEditRevision(e.id)).toBe(0);
    await s.saveEntry({ ...e, note: "migrated" }, 0);
    expect((await s.adapter.read("local")).editRevisions[e.id]).toBe(1);
  });
});
describe("P1 conflict decisions", () => {
  it("retry-settings sends current settings after a later edit", async () => {
    const s = await make();
    await s.saveSettings({ ...defaultSettings(), foodTemplates: ["old"] });
    await s.applyPull(
      s.identityToken(),
      [
        {
          kind: "settings",
          resourceId: "settings",
          version: 2,
          snapshot: defaultSettings(),
          tombstone: false,
        },
      ],
      1,
    );
    await s.saveSettings({ ...defaultSettings(), foodTemplates: ["latest"] });
    await s.resolveConflict("settings", "retry-settings");
    expect(s.getSnapshot().outbox[0].snapshot).toEqual(
      s.getSnapshot().settings,
    );
    expect(s.getSnapshot().outbox[0].baseVersion).toBe(2);
  });
  it.each(["remote", "copy-local"] as const)(
    "rejects stale %s decision after another local edit",
    async (choice) => {
      const { s, e } = await entryConflict();
      await s.saveEntry({ ...e, note: "latest" });
      await expect(s.resolveConflict(e.id, choice, meal())).rejects.toThrow(
        "STALE_CONFLICT",
      );
      expect(s.getSnapshot().records[e.id].note).toBe("latest");
      expect(s.getSnapshot().conflicts).toHaveLength(1);
    },
  );
  it.each([false, true])(
    "copy-local cannot overwrite an occupied ID (tombstone=%s)",
    async (deleted) => {
      const { s, e } = await entryConflict(),
        occupied = meal({ deletedAt: deleted ? at : null });
      await s.saveEntry(occupied);
      const before = await s.adapter.read("local");
      await expect(
        s.resolveConflict(e.id, "copy-local", { ...e, id: occupied.id }),
      ).rejects.toThrow("NEW_COPY_REQUIRED");
      expect(await s.adapter.read("local")).toEqual(before);
    },
  );
  it("copy-local accepts a fresh ID and keeps the original remote", async () => {
    const { s, e } = await entryConflict(),
      copy = { ...e, id: crypto.randomUUID() };
    await s.resolveConflict(e.id, "copy-local", copy);
    expect(s.getSnapshot().records[copy.id]).toEqual(copy);
    expect(s.getSnapshot().records[e.id].note).toBe("remote");
  });
});
describe("P1 ACK validation", () => {
  it("unknown ACK with remote is a complete no-op", async () => {
    const s = await make(),
      e = meal();
    await s.saveEntry(e);
    const before = await s.adapter.read("local");
    await s.acknowledge(
      s.identityToken(),
      crypto.randomUUID(),
      9,
      remote({ ...e, note: "wrong" }, 9),
    );
    expect(await s.adapter.read("local")).toEqual(before);
  });
  it("even a queued change must be registered as sent", async () => {
    const s = await make(),
      e = meal();
    await s.saveEntry(e);
    const before = await s.adapter.read("local");
    await s.acknowledge(
      s.identityToken(),
      s.getSnapshot().outbox[0].changeId,
      1,
    );
    expect(await s.adapter.read("local")).toEqual(before);
  });
  it("duplicate old ACK cannot regress a new pending base version", async () => {
    const s = await make(),
      e = meal();
    await s.saveEntry(e);
    const op = s.pendingOperations()[0];
    await s.acknowledge(s.identityToken(), op.changeId, 5);
    await s.saveEntry({ ...e, note: "new" });
    const before = await s.adapter.read("local");
    await s.acknowledge(s.identityToken(), op.changeId, 1, remote(e, 1));
    expect(await s.adapter.read("local")).toEqual(before);
  });
  it("rejects remote resource mismatch without consuming the sent operation", async () => {
    const s = await make(),
      e = meal();
    await s.saveEntry(e);
    const op = s.pendingOperations()[0],
      before = await s.adapter.read("local");
    await expect(
      s.acknowledge(s.identityToken(), op.changeId, 2, remote(meal(), 2)),
    ).rejects.toThrow("INVALID_ACK");
    expect(await s.adapter.read("local")).toEqual(before);
    await s.acknowledge(s.identityToken(), op.changeId, 2);
    expect(s.getSnapshot().outbox).toHaveLength(0);
  });
  it("rejects ACK version regression", async () => {
    const s = await make(),
      e = meal();
    await s.applyPull(s.identityToken(), [remote(e, 5)], 1);
    await s.saveEntry(e);
    const op = s.pendingOperations()[0];
    await expect(
      s.acknowledge(s.identityToken(), op.changeId, 3),
    ).rejects.toThrow("INVALID_ACK");
    expect(s.getSnapshot().outbox[0].baseVersion).toBe(5);
  });
  it("superseded sent ACK retains new edit and advances its base without invalidating editor", async () => {
    const s = await make(),
      e = meal();
    await s.saveEntry(e);
    const old = s.pendingOperations()[0];
    await s.saveEntry({ ...e, note: "new" });
    const rev = s.getEditRevision(e.id);
    await s.acknowledge(s.identityToken(), old.changeId, 2, remote(e, 2));
    expect(s.getSnapshot().records[e.id].note).toBe("new");
    expect(s.getSnapshot().outbox[0].baseVersion).toBe(2);
    expect(s.getEditRevision(e.id)).toBe(rev);
  });
  it("changing identity clears sent registrations even when returning to the same namespace", async () => {
    const s = await make(),
      e = meal();
    await s.saveEntry(e);
    const old = s.pendingOperations()[0];
    await s.activate(null);
    await s.activate("local");
    const before = await s.adapter.read("local");
    await s.acknowledge(s.identityToken(), old.changeId, 2, remote(e));
    expect(await s.adapter.read("local")).toEqual(before);
  });
});
