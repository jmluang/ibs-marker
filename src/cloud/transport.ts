import type {
  Entry,
  Settings,
  RemoteResource,
  OutboxOperation,
} from "../domain/types";
import { validateEntry, validateSettings } from "../domain/helpers";
import type { ChangeRow, CloudTransport, PushResult } from "./engine";
import { BffClient, BffError } from "./bff";
export function decodeRemote(value: unknown): RemoteResource {
  const r = value as RemoteResource;
  if (
    !r ||
    !["entry", "settings"].includes(r.kind) ||
    !Number.isSafeInteger(r.version) ||
    r.version < 1 ||
    typeof r.tombstone !== "boolean"
  )
    throw new Error("INVALID_REMOTE");
  try {
    if (r.kind === "entry") {
      const e = r.snapshot as Entry;
      if (
        e.id !== r.resourceId ||
        !!e.deletedAt !== r.tombstone ||
        validateEntry(e).length
      )
        throw new Error();
    } else if (
      r.resourceId !== "settings" ||
      r.tombstone ||
      validateSettings(r.snapshot as Settings).length
    )
      throw new Error();
  } catch {
    throw new Error("INVALID_REMOTE");
  }
  return r;
}
/** One transport per accepted identity; this revision never follows a later login. */
export class BffTransport implements CloudTransport {
  private readonly client: BffClient;
  constructor(
    private readonly authRevision: string,
    fetcher: typeof fetch = globalThis.fetch,
  ) {
    this.client = new BffClient(fetcher);
  }
  private async request(path: string, signal: AbortSignal, body?: unknown) {
    try {
      return await this.client.request(path, {
        signal,
        revision: this.authRevision,
        ...(body !== undefined ? ({ method: "POST", body } as const) : {}),
      });
    } catch (error) {
      if (error instanceof BffError && error.code === "SESSION_CHANGED")
        throw new BffError("SESSION_CHANGED", 401);
      throw error;
    }
  }
  async pull(
    cursor: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<ChangeRow[]> {
    const body = (await this.request(
      `/api/sync/pull?cursor=${encodeURIComponent(cursor)}&limit=${encodeURIComponent(limit)}`,
      signal,
    )) as { rows: ChangeRow[] };
    if (!Array.isArray(body.rows)) throw new Error("INVALID_RESPONSE");
    return body.rows.map((row) => {
      if (
        !Number.isSafeInteger(row.seq) ||
        row.seq < 1 ||
        (row.changeId !== undefined && typeof row.changeId !== "string")
      )
        throw new Error("INVALID_RESPONSE");
      return {
        seq: row.seq,
        remote: decodeRemote(row.remote),
        ...(row.changeId !== undefined ? { changeId: row.changeId } : {}),
      };
    });
  }
  async push(
    operation: OutboxOperation,
    signal: AbortSignal,
  ): Promise<PushResult> {
    const body = (await this.request("/api/sync/push", signal, {
      operation,
    })) as { result: PushResult };
    if (!body.result || !["applied", "conflict"].includes(body.result.status))
      throw new Error("INVALID_RESPONSE");
    return {
      status: body.result.status,
      remote: decodeRemote(body.result.remote),
    };
  }
}
