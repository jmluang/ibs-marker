import { afterEach, expect, it, vi } from "vitest";
vi.mock("idb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("idb")>();
  return { ...actual, openDB: vi.fn(actual.openDB) };
});
import { openDB } from "idb";
import { TrackerStore } from "../state/TrackerStore";
import { IndexedDbAdapter } from "../storage/indexedDb";
afterEach(() => vi.mocked(openDB).mockClear());
it("default adapter reports blocked, retries and closes a late successful open", async () => {
  let late!: () => void;
  const close = vi.fn();
  vi.mocked(openDB).mockImplementationOnce(
    (_name, _version, callbacks) =>
      new Promise((resolve) => {
        late = () => resolve({ close } as never);
        queueMicrotask(() =>
          callbacks?.blocked?.(0, 1, {} as IDBVersionChangeEvent),
        );
      }),
  );
  const s = new TrackerStore();
  try {
    const outcome = await Promise.race([
      s.activate("local").then(
        () => "resolved",
        (e) => String(e),
      ),
      new Promise<string>((r) => setTimeout(() => r("HUNG"), 100)),
    ]);
    expect(outcome).toContain("IDB_BLOCKED");
    expect(s.getSnapshot().loading).toBe(false);
    expect(s.getSnapshot().error).toContain("IDB_BLOCKED");
    late();
    await new Promise((r) => setTimeout(r, 0));
    expect(close).toHaveBeenCalledOnce();
    await s.reload();
    expect(s.getSnapshot().error).toBeNull();
    await s.saveDraft("retry", "ok");
    expect(s.getSnapshot().drafts.retry).toBe("ok");
  } finally {
    late();
    s.dispose();
    s.adapter.close();
  }
});
it("failed open is not cached permanently", async () => {
  vi.mocked(openDB).mockRejectedValueOnce(new Error("OPEN_FAILED"));
  const s = new TrackerStore(
    new IndexedDbAdapter("retry-" + crypto.randomUUID()),
  );
  try {
    await expect(s.activate("local")).rejects.toThrow("OPEN_FAILED");
    await s.reload();
    expect(s.getSnapshot().error).toBeNull();
  } finally {
    s.dispose();
    s.adapter.close();
  }
});
