import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { TrackerStore, trackerStore } from "../state/TrackerStore";
import EntryForm from "../components/EntryForm";
import { emptyData } from "../domain/types";
import { IndexedDbAdapter, type StorageAdapter } from "../storage/indexedDb";
import type { Namespace, NamespaceData, ToiletEntry } from "../domain/types";
import {
  applyDurationEdit,
  parseDurationInput,
  durationMinutes,
  exportCsv,
  exportJson,
  statistics,
  validateEntry,
} from "../domain/helpers";
import {
  canonicalOperation,
  canonicalRemote,
} from "../../server/syncValidation";
import { Timeline } from "../components/ui";

const start = "2026-10-20T01:00:00.123Z";
const end = "2026-10-20T01:10:02.456Z";
const entry = (p: Partial<ToiletEntry> = {}): ToiletEntry => ({
  id: crypto.randomUUID(),
  kind: "toilet",
  occurredAt: start,
  createdAt: start,
  updatedAt: start,
  estimatedTime: false,
  deletedAt: null,
  note: "",
  result: "unsure",
  stoolForms: [],
  discomfort: { status: "unknown", symptoms: [] },
  startedAt: start,
  endedAt: end,
  durationSource: "timer",
  estimatedDurationMinutes: null,
  relief: "unknown",
  ...p,
});
const stores: TrackerStore[] = [];
const adapters: StorageAdapter[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.dispose();
  for (const a of adapters.splice(0)) a.close();
});
async function setup() {
  const adapter = new IndexedDbAdapter("duration-edit-" + crypto.randomUUID());
  adapters.push(adapter);
  const store = new TrackerStore(adapter);
  stores.push(store);
  await store.activate("local");
  const timer = await store.startTimer(start);
  await store.finishTimer(end);
  return { store, adapter, e: entry({ id: timer.id }) };
}
// The cast lets the baseline run the behavioral RED before its API is extended.
const finalize = (
  s: TrackerStore,
  e: ToiletEntry,
  options?: { expectedRevision?: number; durationEdited?: boolean },
) =>
  (s.finalizeTimer as (e: ToiletEntry, o?: typeof options) => Promise<void>)(
    e,
    options,
  );

describe("raw duration parsing and edit intent", () => {
  it.each([
    "-",
    "-1",
    "NaN",
    "Infinity",
    "1e309",
    "7.5minutes",
    "0x10",
    "1,2",
    "1e",
    ".",
  ])(
    "rejects invalid raw %j without changing Entry or setting intent",
    (raw) => {
      const e = entry();
      expect(parseDurationInput(raw)).toEqual({ valid: false });
      expect(applyDurationEdit(e, raw)).toEqual({
        entry: e,
        durationEdited: false,
      });
      expect(applyDurationEdit(e, raw).entry).toBe(e);
    },
  );
  it.each([
    0,
    6.5,
    7.125,
    1441,
    1e100,
    1e-7,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
  ])(
    "reopens every finite Number spelling %s without upper/step limits",
    (minutes) => {
      const raw = String(minutes);
      expect(parseDurationInput(raw)).toEqual({ valid: true, minutes });
      const e = entry();
      const edited = applyDurationEdit(e, raw);
      expect(edited.durationEdited).toBe(true);
      expect(edited.entry).toEqual({
        ...e,
        durationSource: "estimated",
        estimatedDurationMinutes: minutes,
      });
      expect(validateEntry(edited.entry)).toEqual([]);
    },
  );
  it("opening, focus and same exact numeric input leave timer and precision unchanged", () => {
    const e = entry();
    const raw = String(durationMinutes(e));
    const same = applyDurationEdit(e, raw);
    expect(same).toEqual({ entry: e, durationEdited: false });
    expect(same.entry).toBe(e);
    expect(same.entry.startedAt).toBe(start);
    expect(same.entry.endedAt).toBe(end);
    const manual = entry({
      durationSource: "estimated",
      estimatedDurationMinutes: 7.125,
    });
    expect(applyDurationEdit(manual, "7.1250").entry).toBe(manual);
  });
  it("changed then original numeric value remains manual intent", () => {
    const e = entry();
    const edited = applyDurationEdit(e, "6.5");
    const restored = applyDurationEdit(
      edited.entry,
      String(durationMinutes(e)),
      edited.durationEdited,
    );
    expect(restored.durationEdited).toBe(true);
    expect(restored.entry).toEqual({
      ...e,
      durationSource: "estimated",
      estimatedDurationMinutes: durationMinutes(e),
    });
  });
  it("explicit clear is unknown/null, never zero or a residual timer", () => {
    const e = entry();
    const cleared = applyDurationEdit(e, "");
    expect(parseDurationInput("")).toEqual({ valid: true, minutes: null });
    expect(cleared).toEqual({
      entry: {
        ...e,
        durationSource: "unknown",
        estimatedDurationMinutes: null,
      },
      durationEdited: true,
    });
    expect(durationMinutes(cleared.entry)).toBeNull();
  });
  it("persists raw invalid text and valid correction in draft only, not Entry/outbox/export", async () => {
    const { store, adapter, e } = await setup();
    const edited = applyDurationEdit(e, "6.5");
    const draft = {
      ...edited,
      durationRaw: "-",
      durationExpanded: false,
      baseRevision: 0,
      editing: false,
    };
    await store.saveDraft("timer-form", draft);
    expect((await adapter.read("local")).drafts["timer-form"]).toEqual(draft);
    await finalize(store, edited.entry, {
      durationEdited: edited.durationEdited,
      expectedRevision: draft.baseRevision,
    });
    const d = await adapter.read("local");
    const saved = d.records[e.id];
    expect(saved).toEqual(edited.entry);
    expect(Object.keys(saved)).not.toContain("durationEdited");
    expect(Object.keys(d.outbox[0].snapshot)).not.toContain("durationRaw");
    expect(exportJson([saved])).not.toContain("durationExpanded");
    expect(canonicalOperation(d.outbox[0]).snapshot).toEqual(saved);
  });
});

describe("explicit timer duration intent and transactional revision", () => {
  it.each([6.5, 0, 7.125, 1e100])(
    "preserves explicit estimated %s and real clock metadata",
    async (minutes) => {
      const { store, adapter, e } = await setup();
      const edited = {
        ...e,
        startedAt: null,
        endedAt: null,
        durationSource: "estimated" as const,
        estimatedDurationMinutes: minutes,
      };
      await finalize(store, edited, {
        durationEdited: true,
        expectedRevision: 0,
      });
      const d = await adapter.read("local");
      expect(d.records[e.id]).toEqual({
        ...edited,
        startedAt: start,
        endedAt: end,
      });
      expect(d.outbox[0].snapshot).toEqual(d.records[e.id]);
      expect(d.timer).toBeNull();
      expect(d.editRevisions[e.id]).toBe(1);
    },
  );
  it("keeps explicit clear unknown rather than reading residual clock", async () => {
    const { store, e } = await setup();
    await finalize(
      store,
      { ...e, durationSource: "unknown" },
      { durationEdited: true },
    );
    const saved = store.getSnapshot().records[e.id] as ToiletEntry;
    expect(saved.durationSource).toBe("unknown");
    expect(saved.estimatedDurationMinutes).toBeNull();
    expect(durationMinutes(saved)).toBeNull();
    expect(saved.startedAt).toBe(start);
    expect(saved.endedAt).toBe(end);
  });
  it.each([undefined, {}, { durationEdited: false }])(
    "legacy/default unknown without intent stays timer: %j",
    async (options) => {
      const { store, e } = await setup();
      await finalize(
        store,
        { ...e, durationSource: "unknown", startedAt: null, endedAt: null },
        options,
      );
      expect(store.getSnapshot().records[e.id]).toEqual(e);
    },
  );
  it("ignores estimated input without explicit intent", async () => {
    const { store, e } = await setup();
    await finalize(store, {
      ...e,
      durationSource: "estimated",
      estimatedDurationMinutes: 6.5,
    });
    expect(store.getSnapshot().records[e.id]).toEqual(e);
  });
  it("preserves untouched millisecond clock and idempotence before CAS", async () => {
    const { store, adapter, e } = await setup();
    await finalize(store, e, { expectedRevision: 0 });
    const before = await adapter.read("local");
    await finalize(
      store,
      { ...e, note: "duplicate" },
      { expectedRevision: 0, durationEdited: true },
    );
    const after = await adapter.read("local");
    expect(after.records).toEqual(before.records);
    expect(after.outbox).toEqual(before.outbox);
    expect(after.editRevisions).toEqual(before.editRevisions);
    expect(durationMinutes(after.records[e.id] as ToiletEntry)).toBe(
      durationMinutes(e),
    );
  });
  it.each([undefined, { expectedRevision: 0 }])(
    "CAS prevents overwriting same ID from another writer: %j",
    async (options) => {
      const { store, adapter, e } = await setup();
      const other = new TrackerStore(adapter);
      stores.push(other);
      await other.activate("local");
      await other.saveEntry({ ...e, note: "newer record" }, 0);
      const before = await adapter.read("local");
      await expect(finalize(store, e, options)).rejects.toThrow(
        "STALE_REVISION",
      );
      expect(await adapter.read("local")).toEqual(before);
    },
  );
  it("accepts captured nonzero revision, independent of draft notifications", async () => {
    const { store, e } = await setup();
    await store.saveEntry(e, 0);
    const captured = store.getEditRevision(e.id);
    await store.saveDraft("timer-form", { entry: e, baseRevision: captured });
    await finalize(
      store,
      { ...e, durationSource: "estimated", estimatedDurationMinutes: 6.5 },
      { expectedRevision: captured, durationEdited: true },
    );
    expect(
      (store.getSnapshot().records[e.id] as ToiletEntry)
        .estimatedDurationMinutes,
    ).toBe(6.5);
  });
  it.each([-1, NaN, Infinity, null])(
    "invalid explicit estimate %s aborts everything",
    async (minutes) => {
      const { store, adapter, e } = await setup();
      const before = await adapter.read("local");
      await expect(
        finalize(
          store,
          {
            ...e,
            durationSource: "estimated",
            estimatedDurationMinutes: minutes,
          },
          { durationEdited: true },
        ),
      ).rejects.toThrow("VALIDATION");
      expect(await adapter.read("local")).toEqual(before);
    },
  );
  it("invalid explicit unknown with an estimate aborts", async () => {
    const { store, adapter, e } = await setup();
    const before = await adapter.read("local");
    await expect(
      finalize(
        store,
        { ...e, durationSource: "unknown", estimatedDurationMinutes: 3 },
        { durationEdited: true },
      ),
    ).rejects.toThrow("VALIDATION");
    expect(await adapter.read("local")).toEqual(before);
  });
  it("write abort preserves record/outbox/timer/draft and permits retry", async () => {
    const { store, adapter, e } = await setup();
    await store.saveDraft("timer-form", {
      entry: e,
      durationRaw: "-",
      durationExpanded: true,
    });
    const before = await adapter.read("local");
    adapter.failNextWrite = true;
    await expect(finalize(store, e, { expectedRevision: 0 })).rejects.toThrow(
      "INJECTED_WRITE_FAILURE",
    );
    expect(await adapter.read("local")).toEqual(before);
    await finalize(store, e, { expectedRevision: 0 });
    expect((await adapter.read("local")).timer).toBeNull();
  });
  it("keeps NO_TIMER and TIMER_MISMATCH guards", async () => {
    const { store, adapter, e } = await setup();
    const before = await adapter.read("local");
    await expect(finalize(store, entry())).rejects.toThrow("TIMER_MISMATCH");
    expect(await adapter.read("local")).toEqual(before);
    await store.cancelTimer();
    await expect(finalize(store, e)).rejects.toThrow("NO_TIMER");
    await store.startTimer(start);
    await expect(finalize(store, entry())).rejects.toThrow("TIMER_MISMATCH");
  });
  it("queued finalize is fenced on identity switch before transaction callback", async () => {
    const { store, adapter, e } = await setup();
    const before = await adapter.read("local");
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const delayed: StorageAdapter = {
      read: (n) => adapter.read(n),
      close: () => {},
      async transact<T>(n: Namespace, change: (d: NamespaceData) => T) {
        entered();
        await gate;
        return adapter.transact(n, change);
      },
    };
    const queued = new TrackerStore(delayed);
    stores.push(queued);
    await queued.activate("local");
    const pending = finalize(queued, e, {
      durationEdited: true,
      expectedRevision: 0,
    });
    const rejected = expect(pending).rejects.toThrow("STALE_IDENTITY");
    await ready;
    await queued.activate(`user:${crypto.randomUUID()}`);
    release();
    await rejected;
    expect(await adapter.read("local")).toEqual(before);
    expect(queued.getSnapshot().entries).toEqual([]);
  });
  it.each([false, true])(
    "ordinary saved-record edits do not touch a %s-ended global timer",
    async (ended) => {
      const { store, adapter, e } = await setup();
      await store.cancelTimer();
      await store.saveEntry(e, 0);
      await store.startTimer(start);
      if (ended) await store.finishTimer(end);
      const timer = (await adapter.read("local")).timer;
      await store.saveEntry(
        { ...e, durationSource: "estimated", estimatedDurationMinutes: 6.5 },
        1,
      );
      expect((await adapter.read("local")).timer).toEqual(timer);
      const before = await adapter.read("local");
      await expect(store.saveEntry(e, 1)).rejects.toThrow("STALE_REVISION");
      expect(await adapter.read("local")).toEqual(before);
    },
  );
});

describe("form render contracts for restored draft UI", () => {
  function form(
    initial: ToiletEntry,
    draft: object | undefined,
    timer: boolean,
  ) {
    vi.spyOn(trackerStore, "identityToken").mockReturnValue({
      namespace: "local",
      generation: 1,
    });
    const snapshot = {
      ...emptyData(),
      entries: [],
      namespace: "local" as const,
      generation: 1,
      loading: false,
      error: null,
      syncStatus: { state: "idle" as const },
      timer: timer
        ? { id: initial.id, startedAt: start, endedAt: end, draft: null }
        : null,
      drafts: draft ? { "duration-fixture": draft } : {},
    };
    vi.spyOn(trackerStore, "getSnapshot").mockReturnValue(snapshot);
    return renderToStaticMarkup(
      createElement(EntryForm, {
        initial,
        timer,
        draftKey: "duration-fixture",
        onClose: () => {},
      }),
    );
  }
  it("saved timer shows exact modify interaction without revealing input initially", () => {
    const html = form(entry(), undefined, false);
    expect(html).toContain("修改用时");
    expect(html).toContain("计时时长：10.0");
    expect(html).not.toContain("用时（分钟）");
  });
  it("legacy unknown timer draft without intent renders the actual clock", () => {
    const initial = entry();
    const html = form(
      initial,
      {
        entry: {
          ...initial,
          durationSource: "unknown",
          startedAt: null,
          endedAt: null,
        },
        baseRevision: 0,
        editing: false,
      },
      true,
    );
    expect(html).toContain("计时时长：10.0");
    expect(html).not.toContain("时长未知");
  });
  it("restores invalid raw text with local error and precise input label", () => {
    const initial = entry();
    const html = form(
      initial,
      {
        entry: initial,
        baseRevision: 0,
        editing: true,
        durationRaw: "-",
        durationExpanded: true,
      },
      false,
    );
    expect(html).toContain("用时（分钟）");
    expect(html).toContain('value="-"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('id="duration-error"');
    expect(html).toContain("请输入有效的非负分钟数");
    expect(html).toContain("收起");
  });
  it.each([0, 6.5])(
    "restored explicit timer correction %s stays manual even collapsed",
    (minutes) => {
      const initial = entry();
      const edited = applyDurationEdit(initial, String(minutes));
      const html = form(
        initial,
        {
          ...edited,
          baseRevision: 0,
          editing: false,
          durationRaw: String(minutes),
          durationExpanded: false,
        },
        true,
      );
      expect(html).toContain(`手动估时 ${minutes} 分钟`);
      expect(html).not.toContain("计时时长：");
      expect(html).toContain("修改用时");
    },
  );
});

describe("duration model remains compatible with stats, export and BFF canonicalization", () => {
  it.each([
    ["estimated", 6.5],
    ["estimated", 0],
    ["unknown", null],
    ["timer", null],
  ] as const)(
    "roundtrips %s/%s with retained original timestamps",
    (source, minutes) => {
      const e = entry({
        durationSource: source,
        estimatedDurationMinutes: minutes,
      });
      expect(validateEntry(e)).toEqual([]);
      const parsed = JSON.parse(exportJson([e])).entries[0] as ToiletEntry;
      expect(parsed).toEqual(e);
      const op = canonicalOperation({
        kind: "entry",
        resourceId: e.id,
        changeId: crypto.randomUUID(),
        baseVersion: 0,
        snapshot: parsed,
        tombstone: false,
      });
      const remote = canonicalRemote({
        kind: "entry",
        resourceId: e.id,
        version: 1,
        snapshot: op.snapshot,
        tombstone: false,
      });
      expect(remote.snapshot).toEqual(e);
      const value = durationMinutes(e);
      const stats = statistics([e]);
      expect(stats.durationKnown).toBe(value === null ? 0 : 1);
      expect(stats.averageDurationMinutes).toBe(value);
      expect(exportCsv([e])).toContain(`"${source}"`);
      expect(exportCsv([e])).toContain(`"${start}"`);
      expect(exportCsv([e])).toContain(`"${end}"`);
    },
  );
  it.each([
    ["estimated", 0, "手动估时 0 分钟"],
    ["estimated", 6.5, "手动估时 6.5 分钟"],
    ["unknown", null, "时长未知"],
  ] as const)(
    "timeline reads known zero and source %s/%s",
    (source, minutes, text) => {
      const html = renderToStaticMarkup(
        createElement(Timeline, {
          entries: [
            entry({
              durationSource: source,
              estimatedDurationMinutes: minutes,
            }),
          ],
          onEdit: () => {},
        }),
      );
      expect(html).toContain(text);
      expect(html).not.toContain("计时时长已记录");
    },
  );
});
