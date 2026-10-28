import type { TrackerStore } from "../state/TrackerStore";
import type {
  OutboxOperation,
  RemoteResource,
  SyncStatus,
} from "../domain/types";
export interface ChangeRow {
  seq: number;
  remote: RemoteResource;
  changeId?: string;
}
export type PushResult = {
  status: "applied" | "conflict";
  remote: RemoteResource;
};
export interface CloudTransport {
  pull(
    cursor: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<ChangeRow[]>;
  push(op: OutboxOperation, signal: AbortSignal): Promise<PushResult>;
}
export function classifyCloudError(error: unknown): SyncStatus {
  const e = (error ?? {}) as {
    status?: number;
    code?: string;
    message?: string;
    name?: string;
  };
  if (e.code === "23505" && e.status !== 401 && e.status !== 403)
    return {
      state: "error",
      message:
        "正餐同日同餐次只能一条。请保留现有版本，或明确将新记录改为加餐后再同步；待同步数据未删除。",
    };
  if (
    e.status === 403 &&
    ["FORBIDDEN", "INVALID_REQUEST"].includes(e.code ?? "")
  )
    return {
      state: "error",
      message: "操作权限不足或请求被拒绝，账号离线副本与待同步队列已保留。",
    };
  if (
    e.status === 401 ||
    (e.status === 409 && e.code === "SESSION_CHANGED") ||
    e.status === 403 ||
    ["PGRST301", "PGRST303", "42501"].includes(e.code ?? "")
  )
    return { state: "auth", message: "会话失效或权限被拒绝，请重新登录。" };
  if (
    (typeof navigator !== "undefined" && navigator.onLine === false) ||
    error instanceof TypeError ||
    /fetch|network|offline/i.test(e.message ?? "")
  )
    return {
      state: "offline",
      message: "网络不可用，账号离线副本与待同步队列已保留。",
    };
  return {
    state: "error",
    message: "同步失败，待同步队列已保留。请检查配置/迁移后重试。",
  };
}
export class SyncEngine {
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;
  onAuthFailure?: () => void;
  constructor(
    private store: TrackerStore,
    private transport: CloudTransport,
    private pageSize = 100,
  ) {}
  cancel() {
    this.controller?.abort();
    this.controller = null;
  }
  sync(): Promise<void> {
    if (this.active) return this.active;
    const namespace = this.store.getSnapshot().namespace;
    if (!namespace?.startsWith("user:")) return Promise.resolve();
    const token = this.store.identityToken();
    const controller = new AbortController();
    this.controller = controller;
    const valid = () =>
      !controller.signal.aborted && this.store.isCurrent(token);
    this.active = (async () => {
      this.store.setSyncStatus(token, { state: "syncing" });
      try {
        let cursor = this.store.getSnapshot().cursor;
        // Register the durable queue so a lost RPC response can be ACKed from its log row.
        const registered = this.store.pendingOperations(token);
        while (valid()) {
          const rows = await this.transport.pull(
            cursor,
            this.pageSize,
            controller.signal,
          );
          if (!valid()) return;
          let next = cursor;
          for (const row of rows) {
            if (!Number.isSafeInteger(row.seq) || row.seq <= next)
              throw new Error("INVALID_CURSOR");
            next = row.seq;
          }
          for (const row of rows) {
            if (
              row.changeId &&
              registered.some(
                (op) =>
                  op.changeId === row.changeId &&
                  op.resourceId === row.remote.resourceId,
              )
            ) {
              if (
                !(await this.store.acknowledge(
                  token,
                  row.changeId,
                  row.remote.version,
                  row.remote,
                ))
              )
                return;
            }
          }
          if (
            rows.length &&
            !(await this.store.applyPull(
              token,
              rows.map((r) => r.remote),
              next,
            ))
          )
            return;
          cursor = next;
          if (rows.length < this.pageSize) break;
        }
        if (!valid()) return;
        const conflicts = new Set(
          this.store.getSnapshot().conflicts.map((c) => c.resourceId),
        );
        const pending = this.store.pendingOperations(token);
        for (const op of pending) {
          if (!valid()) return;
          if (conflicts.has(op.resourceId)) continue;
          const result = await this.transport.push(op, controller.signal);
          if (!valid()) return;
          if (result.status === "conflict")
            await this.store.registerConflict(token, op, result.remote);
          else
            await this.store.acknowledge(
              token,
              op.changeId,
              result.remote.version,
              result.remote,
            );
        }
        if (valid())
          this.store.setSyncStatus(token, {
            state: this.store.getSnapshot().conflicts.length
              ? "conflict"
              : "idle",
          });
      } catch (error) {
        if (valid()) {
          const status = classifyCloudError(error);
          this.store.setSyncStatus(token, status);
          if (status.state === "auth") this.onAuthFailure?.();
        }
      }
    })().finally(() => {
      if (this.controller === controller) this.controller = null;
      this.active = null;
    });
    return this.active;
  }
}
