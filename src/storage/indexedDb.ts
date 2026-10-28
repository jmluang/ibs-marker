import { openDB, type IDBPDatabase } from "idb";
import { emptyData, type Namespace, type NamespaceData } from "../domain/types";
export interface StorageAdapter {
  read(namespace: Namespace): Promise<NamespaceData>;
  transact<T>(
    namespace: Namespace,
    change: (data: NamespaceData) => T,
  ): Promise<{ data: NamespaceData; result: T }>;
  close(): void;
}
// Additive v1 compatibility: existing records/settings are preserved, not reset.
function normalize(data: NamespaceData): NamespaceData {
  data.editRevisions ??= {};
  return data;
}
/** Mutation callback must be synchronous: no network or await inside IDB transaction. */
export class IndexedDbAdapter implements StorageAdapter {
  private db: Promise<IDBPDatabase> | null = null;
  failNextWrite = false;
  constructor(
    readonly name = "ibs-marker-v1",
    private onBlocked?: () => void,
  ) {}
  private open(): Promise<IDBPDatabase> {
    if (this.db) return this.db;
    let abandoned = false;
    const pending = new Promise<IDBPDatabase>((resolve, reject) => {
      const opening = openDB(this.name, 1, {
        upgrade(db) {
          db.createObjectStore("namespaces");
        },
        blocked: () => {
          abandoned = true;
          reject(new Error("IDB_BLOCKED: close other tabs and retry"));
          this.onBlocked?.();
        },
        blocking: () => this.close(),
      });
      void opening.then((db) => {
        if (abandoned || this.db !== pending) db.close();
        else resolve(db);
      }, reject);
    });
    this.db = pending;
    void pending.catch(() => {
      if (this.db === pending) this.db = null;
    });
    return pending;
  }
  async read(namespace: Namespace): Promise<NamespaceData> {
    return normalize(
      structuredClone(
        (await (await this.open()).get("namespaces", namespace)) ?? emptyData(),
      ),
    );
  }
  async transact<T>(
    namespace: Namespace,
    change: (data: NamespaceData) => T,
  ): Promise<{ data: NamespaceData; result: T }> {
    const db = await this.open();
    const tx = db.transaction("namespaces", "readwrite");
    try {
      const data = normalize((await tx.store.get(namespace)) ?? emptyData());
      const result = change(data);
      if (this.failNextWrite) {
        this.failNextWrite = false;
        throw new Error("INJECTED_WRITE_FAILURE");
      }
      await tx.store.put(data, namespace);
      await tx.done;
      return { data: structuredClone(data), result };
    } catch (error) {
      try {
        tx.abort();
      } catch {}
      await tx.done.catch(() => {});
      throw error;
    }
  }
  close() {
    const db = this.db;
    this.db = null;
    if (db)
      void db.then(
        (d) => d.close(),
        () => {},
      );
  }
}
