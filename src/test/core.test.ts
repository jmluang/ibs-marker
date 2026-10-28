import { describe, it, expect } from "vitest";
import {
  validateEntry,
  shanghaiDate,
  statistics,
  exportCsv,
  lastPassed,
  completeness,
} from "../domain/helpers";
import { TrackerStore } from "../state/TrackerStore";
import { IndexedDbAdapter } from "../storage/indexedDb";
import type { ToiletEntry } from "../domain/types";
const now = "2026-10-20T01:00:00.000Z";
const entry = (p: Partial<ToiletEntry> = {}): ToiletEntry => ({
  id: crypto.randomUUID(),
  kind: "toilet",
  occurredAt: now,
  createdAt: now,
  updatedAt: now,
  estimatedTime: false,
  deletedAt: null,
  result: "passed",
  stoolForms: [4],
  discomfort: { status: "unknown", symptoms: [] },
  startedAt: now,
  endedAt: null,
  durationSource: "unknown",
  estimatedDurationMinutes: null,
  relief: "unknown",
  note: "",
  ...p,
});
const store = () =>
  new TrackerStore(new IndexedDbAdapter("test-" + crypto.randomUUID()));
describe("domain", () => {
  it("rejects contradictory stool and discomfort", () => {
    expect(validateEntry(entry({ result: "none" }))).not.toEqual([]);
    expect(validateEntry(entry({ stoolForms: [] }))).not.toEqual([]);
    expect(
      validateEntry(
        entry({ discomfort: { status: "reported", symptoms: [] } }),
      ),
    ).not.toEqual([]);
  });
  it("distinguishes unknown, actual and estimated duration", () => {
    expect(validateEntry(entry())).toEqual([]);
    expect(
      validateEntry(
        entry({ endedAt: "2026-10-20T00:00:00Z", durationSource: "timer" }),
      ),
    ).not.toEqual([]);
  });
  it("uses Shanghai day and passed-only last event", () => {
    expect(shanghaiDate("2026-10-19T18:00:00Z")).toBe("2026-10-20");
    expect(
      lastPassed([
        entry(),
        entry({
          result: "none",
          stoolForms: [],
          occurredAt: "2026-10-20T02:00:00Z",
        }),
      ])?.occurredAt,
    ).toBe(now);
  });
  it("keeps known denominators and missing counts", () => {
    const s = statistics([
      entry(),
      entry({
        result: "none",
        stoolForms: [],
        discomfort: { status: "none", symptoms: [] },
      }),
    ]);
    expect(s.toiletCount).toBe(2);
    expect(s.passedCount).toBe(1);
    expect(s.discomfortKnown).toBe(1);
    expect(s.discomfortUnknown).toBe(1);
    expect(s.averageDurationMinutes).toBeNull();
  });
  it("exports missing data and neutralizes CSV formulas", () => {
    expect(exportCsv([entry({ note: "=SUM(A1)" })])).toContain("'=SUM(A1)");
    expect(exportCsv([entry()])).toContain("unknown");
  });
  it("reports completeness without a made-up score", () => {
    expect(completeness([], "2026-10-20").mealsConfirmed).toBe(0);
  });
});
describe("transactional local store", () => {
  it("persists records and outbox together", async () => {
    const s = store();
    await s.activate("local");
    const e = entry();
    await s.saveEntry(e);
    const r = new TrackerStore(s.adapter);
    await r.activate("local");
    expect(r.getSnapshot().entries).toHaveLength(1);
    expect(r.getSnapshot().outbox).toHaveLength(1);
    s.dispose();
    r.dispose();
  });
  it("rolls back adapter-injected failure", async () => {
    const s = store();
    await s.activate("local");
    (s.adapter as IndexedDbAdapter).failNextWrite = true;
    await expect(s.saveEntry(entry())).rejects.toThrow();
    expect(s.getSnapshot().entries).toHaveLength(0);
    await s.reload();
    expect(s.getSnapshot().outbox).toHaveLength(0);
    s.dispose();
  });
  it("guards stale identities and namespace isolation", async () => {
    const s = store();
    await s.activate("local");
    const token = s.identityToken();
    await s.activate(`user:${crypto.randomUUID()}`);
    expect(await s.applyPull(token, [], 1)).toBe(false);
    expect(s.getSnapshot().cursor).toBe(0);
    s.dispose();
  });
  it("restores timer draft and finalizes same ID idempotently", async () => {
    const s = store();
    await s.activate("local");
    const t = await s.startTimer(now);
    await s.finishTimer("2026-10-20T01:10:00Z");
    await s.reload();
    expect(s.getSnapshot().timer?.endedAt).not.toBeNull();
    const e = entry({
      id: t.id,
      endedAt: "2026-10-20T01:10:00Z",
      durationSource: "timer",
    });
    await Promise.all([s.finalizeTimer(e), s.finalizeTimer(e)]);
    expect(s.getSnapshot().entries).toHaveLength(1);
    expect(s.getSnapshot().timer).toBeNull();
    s.dispose();
  });
  it("rejects stale revision across tabs and single active timer", async () => {
    const s = store();
    const b = new TrackerStore(s.adapter);
    await s.activate("local");
    await b.activate("local");
    const t = await s.startTimer(now);
    expect((await b.startTimer(now)).id).toBe(t.id);
    const e = entry();
    await s.saveEntry(e);
    await expect(b.saveEntry({ ...e, note: "stale" }, 0)).rejects.toThrow(
      "STALE_REVISION",
    );
    s.dispose();
    b.dispose();
  });
  it("ACK cannot erase a later edit", async () => {
    const s = store();
    await s.activate("local");
    const e = entry();
    await s.saveEntry(e);
    const old = s.pendingOperations()[0];
    await s.saveEntry({ ...e, note: "new" });
    await s.acknowledge(s.identityToken(), old.changeId, 1);
    expect(s.getSnapshot().outbox).toHaveLength(1);
    expect(s.getSnapshot().entries[0].note).toBe("new");
    expect(s.getSnapshot().outbox[0].baseVersion).toBe(1);
    s.dispose();
  });
  it("versions settings, drafts and deletion tombstones", async () => {
    const s = store();
    await s.activate("local");
    await s.saveSettings({
      ...s.getSnapshot().settings,
      foodTemplates: ["粥"],
    });
    const e = entry();
    await s.saveDraft("form", e);
    await s.saveEntry(e);
    await s.deleteEntry(e.id);
    await s.reload();
    expect(s.getSnapshot().entries).toHaveLength(0);
    expect(s.getSnapshot().records[e.id].deletedAt).not.toBeNull();
    expect(s.getSnapshot().drafts.form).toEqual(e);
    expect(s.getSnapshot().outbox.some((o) => o.kind === "settings")).toBe(
      true,
    );
    s.dispose();
  });
});
