import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUuid } from "../domain/uuid";
import { newEntry } from "../components/EntryForm";
import { TrackerStore } from "../state/TrackerStore";
import { IndexedDbAdapter } from "../storage/indexedDb";

const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function withoutNativeUuid() {
  vi.stubGlobal("crypto", {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("UUIDs on HTTP LAN origins", () => {
  it("uses native randomUUID with its Crypto receiver when present", () => {
    const id = crypto.randomUUID();
    const native = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis.crypto);
      return id;
    });
    vi.stubGlobal("crypto", { randomUUID: native });
    expect(randomUuid()).toBe(id);
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("generates 1000 distinct v4 UUIDs without randomUUID or Math.random", () => {
    withoutNativeUuid();
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random must not generate identifiers");
    });
    const ids = Array.from({ length: 1000 }, () => randomUuid());
    expect(ids.every((id) => v4.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(1000);
  });
  it("sets the version and variant bits even for all-ones entropy", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(255),
    });
    expect(randomUuid()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });
  it("fails closed if no cryptographic random source exists", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => randomUuid()).toThrow("CRYPTO_UNAVAILABLE");
  });
  it("creates every entry kind, queues persisted records and finalizes timers without native UUID", async () => {
    const adapter = new IndexedDbAdapter("http-lan-uuid-" + crypto.randomUUID());
    const store = new TrackerStore(adapter);
    const reloaded = new TrackerStore(adapter);
    withoutNativeUuid();
    try {
      await store.activate("local");
      for (const kind of ["meal", "symptom", "toilet"] as const) {
        const entry = newEntry(kind);
        expect(entry.id).toMatch(v4);
        await store.saveEntry(entry);
      }
      const timer = await store.startTimer("2026-10-20T01:00:00Z");
      expect(timer.id).toMatch(v4);
      await store.finishTimer("2026-10-20T01:05:00Z");
      const toilet = newEntry("toilet");
      if (toilet.kind !== "toilet") throw new Error("Wrong entry kind");
      await store.finalizeTimer({ ...toilet, id: timer.id });
      await store.saveSettings(store.getSnapshot().settings);
      await reloaded.activate("local");
      expect(reloaded.getSnapshot().entries).toHaveLength(4);
      expect(reloaded.getSnapshot().timer).toBeNull();
      expect(reloaded.getSnapshot().outbox).toHaveLength(5);
      expect(reloaded.getSnapshot().outbox.every((op) => v4.test(op.changeId))).toBe(true);
    } finally {
      store.dispose();
      reloaded.dispose();
    }
  });
});
