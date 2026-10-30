import {
  emptyData,
  type Namespace,
  type NamespaceData,
  type IdentityToken,
  type TrackerSnapshot,
  type Entry,
  type Settings,
  type OutboxOperation,
  type RemoteResource,
  type SyncStatus,
  type ActiveTimer,
} from "../domain/types";
import {
  validateEntry,
  validateSettings,
  shanghaiDate,
  sortEntries,
} from "../domain/helpers";
import { IndexedDbAdapter, type StorageAdapter } from "../storage/indexedDb";
import { jsonEqual } from "../domain/jsonEqual";
import { randomUuid } from "../domain/uuid";
export class TrackerStore {
  private listeners = new Set<() => void>();
  private channel: BroadcastChannel | null = null;
  private snapshot: TrackerSnapshot = {
    ...emptyData(),
    entries: [],
    namespace: null,
    generation: 0,
    loading: false,
    error: null,
    syncStatus: { state: "idle" },
  };
  constructor(readonly adapter: StorageAdapter = new IndexedDbAdapter()) {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel("ibs-marker-changes");
      this.channel.onmessage = (e) => {
        if (e.data.namespace === this.snapshot.namespace)
          void this.reload().catch(() => {});
      };
    }
  }
  getSnapshot = () => this.snapshot;
  getEditRevision = (resourceId: string) =>
    this.snapshot.editRevisions[resourceId] ?? 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    for (const listener of this.listeners) listener();
  }
  identityToken(): IdentityToken {
    if (!this.snapshot.namespace) throw new Error("NO_IDENTITY");
    return {
      namespace: this.snapshot.namespace,
      generation: this.snapshot.generation,
    };
  }
  isCurrent(token: IdentityToken) {
    return (
      this.snapshot.namespace === token.namespace &&
      this.snapshot.generation === token.generation
    );
  }
  private publish(data: NamespaceData, token: IdentityToken) {
    if (!this.isCurrent(token) || data.revision < this.snapshot.revision)
      return;
    this.snapshot = {
      ...this.snapshot,
      ...data,
      entries: sortEntries(Object.values(data.records)),
      loading: false,
      error: null,
    };
    this.emit();
  }
  async activate(namespace: Namespace | null) {
    if (
      namespace !== null &&
      namespace !== "local" &&
      !/^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        namespace,
      )
    )
      throw new Error("INVALID_NAMESPACE");
    this.sentOperations.clear();
    this.snapshot = {
      ...emptyData(),
      entries: [],
      namespace,
      generation: this.snapshot.generation + 1,
      loading: namespace !== null,
      error: null,
      syncStatus: { state: "idle" },
    };
    this.emit();
    if (namespace) await this.reload();
  }
  async reload() {
    const token = this.identityToken();
    try {
      const data = await this.adapter.read(token.namespace);
      this.publish(data, token);
    } catch (error) {
      if (this.isCurrent(token)) {
        this.snapshot = {
          ...this.snapshot,
          loading: false,
          error: String(error),
        };
        this.emit();
      }
      throw error;
    }
  }
  private async mutate<T>(
    change: (data: NamespaceData) => T,
    expectedRevision?: number,
    token = this.identityToken(),
    resourceId?: string,
  ): Promise<T> {
    if (!this.isCurrent(token)) throw new Error("STALE_IDENTITY");
    try {
      const { data, result } = await this.adapter.transact(
        token.namespace,
        (d) => {
          if (!this.isCurrent(token)) throw new Error("STALE_IDENTITY");
          if (
            expectedRevision !== undefined &&
            (d.editRevisions[resourceId!] ?? 0) !== expectedRevision
          )
            throw new Error("STALE_REVISION");
          const result = change(d);
          d.revision++;
          return result;
        },
      );
      this.publish(data, token);
      this.channel?.postMessage({
        namespace: token.namespace,
        revision: data.revision,
      });
      return result;
    } catch (error) {
      if (this.isCurrent(token)) {
        this.snapshot = { ...this.snapshot, error: String(error) };
        this.emit();
      }
      throw error;
    }
  }
  private queue(
    d: NamespaceData,
    kind: "entry" | "settings",
    resourceId: string,
    snapshot: Entry | Settings,
    tombstone = false,
  ) {
    const op: OutboxOperation = {
      kind,
      resourceId,
      changeId: randomUuid(),
      baseVersion: d.versions[resourceId] ?? 0,
      snapshot: structuredClone(snapshot),
      tombstone,
    };
    d.outbox = d.outbox.filter((o) => o.resourceId !== resourceId);
    d.outbox.push(op);
  }
  private putEntry(d: NamespaceData, e: Entry) {
    const errors = validateEntry(e);
    if (errors.length) throw new Error("VALIDATION: " + errors.join(", "));
    if (
      e.kind === "meal" &&
      e.slot !== "snack" &&
      !e.deletedAt &&
      Object.values(d.records).some(
        (other) =>
          other.id !== e.id &&
          !other.deletedAt &&
          other.kind === "meal" &&
          other.slot === e.slot &&
          shanghaiDate(other.occurredAt) === shanghaiDate(e.occurredAt),
      )
    )
      throw new Error("MEAL_SLOT_EXISTS");
    d.records[e.id] = structuredClone(e);
    d.editRevisions[e.id] = (d.editRevisions[e.id] ?? 0) + 1;
    this.queue(d, "entry", e.id, e, !!e.deletedAt);
  }
  saveEntry(entry: Entry, expectedRevision = this.getEditRevision(entry.id)) {
    return this.mutate(
      (d) => this.putEntry(d, entry),
      expectedRevision,
      this.identityToken(),
      entry.id,
    );
  }
  deleteEntry(id: string, expectedRevision = this.getEditRevision(id)) {
    return this.mutate(
      (d) => {
        const e = d.records[id];
        if (!e) throw new Error("NOT_FOUND");
        const at = new Date().toISOString();
        this.putEntry(d, { ...e, deletedAt: at, updatedAt: at });
      },
      expectedRevision,
      this.identityToken(),
      id,
    );
  }
  saveSettings(
    settings: Settings,
    expectedRevision = this.getEditRevision("settings"),
  ) {
    return this.mutate(
      (d) => {
        const errors = validateSettings(settings);
        if (errors.length) throw new Error("VALIDATION: " + errors.join(", "));
        d.settings = structuredClone(settings);
        d.editRevisions.settings = (d.editRevisions.settings ?? 0) + 1;
        this.queue(d, "settings", "settings", settings);
      },
      expectedRevision,
      this.identityToken(),
      "settings",
    );
  }
  saveDraft(key: string, value: unknown) {
    return this.mutate((d) => {
      d.drafts[key] = structuredClone(value);
    });
  }
  clearDraft(key: string) {
    return this.mutate((d) => {
      delete d.drafts[key];
    });
  }
  startTimer(startedAt = new Date().toISOString()): Promise<ActiveTimer> {
    return this.mutate((d) => {
      if (d.timer) return d.timer;
      if (!Number.isFinite(Date.parse(startedAt)))
        throw new Error("INVALID_TIME");
      return (d.timer = {
        id: randomUuid(),
        startedAt,
        endedAt: null,
        draft: null,
      });
    });
  }
  finishTimer(endedAt = new Date().toISOString()) {
    return this.mutate((d) => {
      if (!d.timer) throw new Error("NO_TIMER");
      if (
        !Number.isFinite(Date.parse(endedAt)) ||
        Date.parse(endedAt) < Date.parse(d.timer.startedAt)
      )
        throw new Error("INVALID_TIME");
      if (!d.timer.endedAt) {
        d.timer.endedAt = endedAt;
        d.timer.draft = {
          id: d.timer.id,
          kind: "toilet",
          startedAt: d.timer.startedAt,
          occurredAt: d.timer.startedAt,
          endedAt,
          durationSource: "timer",
        };
      }
      return d.timer;
    });
  }
  saveTimerDraft(draft: Partial<import("../domain/types").ToiletEntry>) {
    return this.mutate((d) => {
      if (!d.timer) throw new Error("NO_TIMER");
      d.timer.draft = {
        ...draft,
        id: d.timer.id,
        startedAt: d.timer.startedAt,
        endedAt: d.timer.endedAt,
      };
    });
  }
  finalizeTimer(
    entry: import("../domain/types").ToiletEntry,
    options?: { expectedRevision?: number; durationEdited?: boolean },
  ) {
    const expectedRevision = options?.expectedRevision ?? 0;
    const durationEdited = options?.durationEdited === true;
    return this.mutate((d) => {
      if (!d.timer) {
        if (d.records[entry.id]) return;
        throw new Error("NO_TIMER");
      }
      if (d.timer.id !== entry.id || !d.timer.endedAt)
        throw new Error("TIMER_MISMATCH");
      // This CAS must follow the duplicate-finalize return, inside the transaction.
      if ((d.editRevisions[entry.id] ?? 0) !== expectedRevision)
        throw new Error("STALE_REVISION");
      const preserveDuration =
        durationEdited &&
        (entry.durationSource === "estimated" ||
          entry.durationSource === "unknown");
      this.putEntry(d, {
        ...entry,
        startedAt: d.timer.startedAt,
        endedAt: d.timer.endedAt,
        durationSource: preserveDuration ? entry.durationSource : "timer",
        estimatedDurationMinutes: preserveDuration
          ? entry.estimatedDurationMinutes
          : null,
      });
      d.timer = null;
    });
  }
  cancelTimer() {
    return this.mutate((d) => {
      d.timer = null;
    });
  }
  setSyncStatus(token: IdentityToken, status: SyncStatus) {
    if (!this.isCurrent(token)) return false;
    this.snapshot = { ...this.snapshot, syncStatus: status };
    this.emit();
    return true;
  }
  async acknowledge(
    token: IdentityToken,
    changeId: string,
    version: number,
    remote?: RemoteResource,
  ) {
    if (!this.isCurrent(token)) return false;
    const sent = this.sentOperations.get(changeId);
    if (!sent) return true;
    await this.mutate(
      (d) => {
        // A concurrent duplicate may have completed while this transaction waited.
        if (this.sentOperations.get(changeId) !== sent) return;
        const current = d.outbox.find((o) => o.resourceId === sent.resourceId);
        if (
          !Number.isSafeInteger(version) ||
          version <= sent.baseVersion ||
          version < (d.versions[sent.resourceId] ?? 0) ||
          version < (current?.baseVersion ?? 0) ||
          (remote &&
            (remote.resourceId !== sent.resourceId ||
              remote.kind !== sent.kind ||
              remote.version !== version ||
              (remote.kind === "entry" &&
                (remote.snapshot as Entry).id !== sent.resourceId)))
        )
          throw new Error("INVALID_ACK");
        this.ackData(d, sent.resourceId, changeId, version, remote);
      },
      undefined,
      token,
    );
    if (this.sentOperations.get(changeId) === sent)
      this.sentOperations.delete(changeId);
    return this.isCurrent(token);
  }
  private sentOperations = new Map<string, OutboxOperation>();
  pendingOperations(token = this.identityToken()) {
    if (!this.isCurrent(token)) return [];
    const ops = structuredClone(this.snapshot.outbox);
    for (const op of ops) this.sentOperations.set(op.changeId, op);
    return ops;
  }
  private ackData(
    d: NamespaceData,
    resourceId: string,
    changeId: string,
    version: number,
    remote?: RemoteResource,
  ) {
    d.versions[resourceId] = Math.max(d.versions[resourceId] ?? 0, version);
    const current = d.outbox.find((o) => o.resourceId === resourceId);
    if (current?.changeId === changeId) {
      d.outbox = d.outbox.filter((o) => o.changeId !== changeId);
      if (remote) this.land(d, remote);
    } else if (current) {
      current.baseVersion = version;
    }
  }
  private land(d: NamespaceData, r: RemoteResource) {
    if (r.version < (d.versions[r.resourceId] ?? 0)) return;
    const previous =
      r.kind === "settings" ? d.settings : d.records[r.resourceId];
    if (!jsonEqual(previous, r.snapshot))
      d.editRevisions[r.resourceId] = (d.editRevisions[r.resourceId] ?? 0) + 1;
    if (r.kind === "settings")
      d.settings = structuredClone(r.snapshot as Settings);
    else d.records[r.resourceId] = structuredClone(r.snapshot as Entry);
    d.versions[r.resourceId] = r.version;
  }
  async applyPull(
    token: IdentityToken,
    resources: RemoteResource[],
    cursor: number,
  ) {
    if (!this.isCurrent(token)) return false;
    await this.mutate(
      (d) => {
        if (cursor < d.cursor) throw new Error("STALE_CURSOR");
        for (const remote of resources) {
          const local = d.outbox.find(
            (o) => o.resourceId === remote.resourceId,
          );
          if (local) {
            if (remote.version > local.baseVersion) {
              d.conflicts = d.conflicts.filter(
                (c) => c.resourceId !== remote.resourceId,
              );
              d.conflicts.push({
                resourceId: remote.resourceId,
                local: structuredClone(local),
                remote: structuredClone(remote),
              });
            }
          } else this.land(d, remote);
        }
        d.cursor = cursor;
      },
      undefined,
      token,
    );
    return this.isCurrent(token);
  }
  registerConflict(
    token: IdentityToken,
    local: OutboxOperation,
    remote: RemoteResource,
  ) {
    if (!this.isCurrent(token)) return Promise.resolve(false);
    return this.mutate(
      (d) => {
        d.conflicts = d.conflicts.filter(
          (c) => c.resourceId !== local.resourceId,
        );
        d.conflicts.push({
          resourceId: local.resourceId,
          local: structuredClone(local),
          remote: structuredClone(remote),
        });
        return true;
      },
      undefined,
      token,
    );
  }
  resolveConflict(
    resourceId: string,
    choice: "remote" | "retry-settings" | "copy-local",
    copy?: Entry,
  ) {
    return this.mutate((d) => {
      const c = d.conflicts.find((c) => c.resourceId === resourceId);
      if (!c) throw new Error("NO_CONFLICT");
      if (choice === "retry-settings") {
        if (c.local.kind !== "settings") throw new Error("SETTINGS_ONLY");
        d.versions[resourceId] = Math.max(
          d.versions[resourceId] ?? 0,
          c.remote.version,
        );
        this.queue(d, "settings", resourceId, d.settings);
      } else {
        if (
          d.outbox.find((o) => o.resourceId === resourceId)?.changeId !==
          c.local.changeId
        )
          throw new Error("STALE_CONFLICT");
        if (choice === "copy-local") {
          if (
            c.local.kind !== "entry" ||
            !copy ||
            copy.id === resourceId ||
            Object.hasOwn(d.records, copy.id) ||
            Object.hasOwn(d.versions, copy.id) ||
            d.outbox.some((o) => o.resourceId === copy.id)
          )
            throw new Error("NEW_COPY_REQUIRED");
          this.putEntry(d, copy);
        }
        d.outbox = d.outbox.filter((o) => o.resourceId !== resourceId);
        this.land(d, c.remote);
      }
      d.conflicts = d.conflicts.filter((c) => c.resourceId !== resourceId);
    });
  }
  async clearCurrentNamespace(confirmed: boolean) {
    if (!confirmed) throw new Error("CONFIRM_REQUIRED");
    await this.mutate((d) =>
      Object.assign(d, emptyData(), { revision: d.revision }),
    );
  }
  dispose() {
    this.channel?.close();
    this.listeners.clear();
  }
}
export const trackerStore = new TrackerStore();
