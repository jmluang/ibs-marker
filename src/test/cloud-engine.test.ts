import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { TrackerStore } from "../state/TrackerStore";
import { IndexedDbAdapter } from "../storage/indexedDb";
import {
  defaultSettings,
  type Entry,
  type RemoteResource,
} from "../domain/types";
import { SyncEngine, type CloudTransport } from "../cloud/engine";
import { readCloudConfig } from "../cloud/config";
const uid = "11111111-1111-4111-8111-111111111111";
const entry = (): Entry => ({
  id: crypto.randomUUID(),
  kind: "symptom",
  occurredAt: "2026-10-20T00:00:00.000Z",
  createdAt: "2026-10-20T01:00:00.000Z",
  updatedAt: "2026-10-20T01:00:00.000Z",
  estimatedTime: true,
  deletedAt: null,
  note: "",
  discomfort: { status: "unknown", symptoms: [] },
  context: "",
});
const stores: TrackerStore[] = [];
async function setup(transport: CloudTransport, size = 2) {
  const store = new TrackerStore(new IndexedDbAdapter(crypto.randomUUID()));
  stores.push(store);
  await store.activate(`user:${uid}`);
  return { store, engine: new SyncEngine(store, transport, size) };
}
afterEach(() =>
  stores.splice(0).forEach((s) => {
    s.dispose();
    s.adapter.close();
  }),
);
const remote = (e: Entry, version = 1): RemoteResource => ({
  kind: "entry",
  resourceId: e.id,
  version,
  snapshot: e,
  tombstone: !!e.deletedAt,
});
const ok: CloudTransport = {
  pull: async () => [],
  push: async (op) => ({
    status: "applied",
    remote: { ...op, version: op.baseVersion + 1 },
  }),
};
describe("isolated injected transport, not vendor Auth acceptance", () => {
  it("defaults to BFF with only explicit nonproduction local selection", () => {
    expect(readCloudConfig({}).state).toBe("ready");
    expect(readCloudConfig({ VITE_APP_MODE: "local" }).state).toBe("absent");
    expect(readCloudConfig({ VITE_APP_MODE: "local", PROD: true }).state).toBe(
      "ready",
    );
  });
  it("registers sent operations and ACKs only after push", async () => {
    const { store, engine } = await setup(ok);
    await store.saveEntry(entry());
    await engine.sync();
    expect(store.getSnapshot().outbox).toHaveLength(0);
    expect(store.getSnapshot().syncStatus.state).toBe("idle");
  });
  it("retains outbox after response loss and retries identical changeId", async () => {
    const sent: string[] = [];
    const { store, engine } = await setup({
      ...ok,
      push: async (op) => {
        sent.push(op.changeId);
        if (sent.length === 1) throw new TypeError("Failed to fetch");
        return { status: "applied", remote: { ...op, version: 1 } };
      },
    });
    await store.saveEntry(entry());
    await engine.sync();
    expect(store.getSnapshot().outbox).toHaveLength(1);
    expect(store.getSnapshot().syncStatus.state).toBe("offline");
    await engine.sync();
    expect(sent[0]).toBe(sent[1]);
    expect(store.getSnapshot().outbox).toHaveLength(0);
  });
  it("ignores late identity response and cancels old round", async () => {
    let release!: (r: { status: "applied"; remote: RemoteResource }) => void;
    const { store, engine } = await setup({
      ...ok,
      push: () => new Promise((r) => (release = r)),
    });
    const e = entry();
    await store.saveEntry(e);
    const job = engine.sync();
    await new Promise((r) => setTimeout(r, 0));
    await store.activate(null);
    release({ status: "applied", remote: remote(e) });
    await job;
    expect(store.getSnapshot().namespace).toBe(null);
    expect(store.getSnapshot().entries).toEqual([]);
  });
  it("preserves edits made while push is in flight and rebases queue", async () => {
    let release!: (r: { status: "applied"; remote: RemoteResource }) => void;
    const { store, engine } = await setup({
      ...ok,
      push: () => new Promise((r) => (release = r)),
    });
    const e = entry();
    await store.saveEntry(e);
    const job = engine.sync();
    await new Promise((r) => setTimeout(r, 0));
    await store.saveEntry({ ...e, note: "new" });
    release({ status: "applied", remote: remote(e) });
    await job;
    expect(store.getSnapshot().entries[0].note).toBe("new");
    expect(store.getSnapshot().outbox[0].baseVersion).toBe(1);
  });
  it("pulls seq pages from zero atomically, preserves snapshot time and avoids conflicted deletion push", async () => {
    const e = entry();
    const dead = { ...e, deletedAt: "2026-10-20T03:00:00.000Z" };
    const cursors: number[] = [];
    const pushed: string[] = [];
    const { store, engine } = await setup({
      pull: async (cursor) => {
        cursors.push(cursor);
        return cursor === 0
          ? [
              { seq: 2, remote: remote(e) },
              { seq: 5, remote: remote(dead, 2) },
            ]
          : [];
      },
      push: async (op) => {
        pushed.push(op.changeId);
        return { status: "applied", remote: remote(e) };
      },
    });
    await store.saveEntry(e);
    await engine.sync();
    expect(cursors).toEqual([0, 5]);
    expect(store.getSnapshot().cursor).toBe(5);
    expect(store.getSnapshot().conflicts[0].remote.tombstone).toBe(true);
    expect(
      (store.getSnapshot().conflicts[0].remote.snapshot as Entry).occurredAt,
    ).toBe(e.occurredAt);
    expect(pushed).toEqual([]);
    expect(store.getSnapshot().outbox).toHaveLength(1);
  });
  it("settings conflict stays queued and retry uses current settings", async () => {
    const { store, engine } = await setup({
      ...ok,
      push: async () => ({
        status: "conflict",
        remote: {
          kind: "settings",
          resourceId: "settings",
          version: 2,
          snapshot: defaultSettings(),
          tombstone: false,
        },
      }),
    });
    await store.saveSettings({
      ...defaultSettings(),
      foodTemplates: ["first"],
    });
    await engine.sync();
    await store.saveSettings({
      ...defaultSettings(),
      foodTemplates: ["latest"],
    });
    await store.resolveConflict("settings", "retry-settings");
    expect(store.getSnapshot().outbox[0].snapshot).toMatchObject({
      foodTemplates: ["latest"],
    });
    expect(store.getSnapshot().outbox[0].baseVersion).toBe(2);
    await engine.sync();
    expect(store.getSnapshot().syncStatus.state).toBe("conflict");
  });
  it("recovers a committed lost response from owned change-log identity without false conflict", async () => {
    const e = entry();
    let committed: {
      seq: number;
      remote: RemoteResource;
      changeId: string;
    } | null = null;
    let pushes = 0;
    const { store, engine } = await setup({
      pull: async (cursor) => (committed && cursor === 0 ? [committed] : []),
      push: async (op) => {
        pushes++;
        committed = { seq: 1, remote: remote(e), changeId: op.changeId };
        throw new TypeError("Failed to fetch");
      },
    });
    await store.saveEntry(e);
    await engine.sync();
    expect(store.getSnapshot().outbox).toHaveLength(1);
    await engine.sync();
    expect(pushes).toBe(1);
    expect(store.getSnapshot().outbox).toHaveLength(0);
    expect(store.getSnapshot().conflicts).toHaveLength(0);
    expect(store.getSnapshot().cursor).toBe(1);
  });
  it("deduplicates simultaneous sync rounds", async () => {
    let calls = 0;
    const { engine } = await setup({
      ...ok,
      pull: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return [];
      },
    });
    await Promise.all([engine.sync(), engine.sync()]);
    expect(calls).toBe(1);
  });
  it("classifies auth separately and invokes identity invalidation", async () => {
    let expired = false;
    const { store, engine } = await setup({
      ...ok,
      pull: async () => {
        throw { status: 401, message: "expired" };
      },
    });
    engine.onAuthFailure = () => {
      expired = true;
    };
    await engine.sync();
    expect(expired).toBe(true);
    expect(store.getSnapshot().syncStatus.state).toBe("auth");
  });
});
