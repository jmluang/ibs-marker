import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, resolve, parse, join } from "node:path";
import type { BackendUser } from "../src/domain/backendApi.ts";
export interface StoredAuth {
  user: BackendUser;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  needsVerification?: boolean;
}
export interface SessionContext {
  authRevision: string;
  attemptId: string | null;
  auth: StoredAuth | null;
  expiresAt: number;
}
export class SessionStoreError extends Error {
  constructor() {
    super("SESSION_STORE_UNAVAILABLE");
  }
}
export class SessionChangedError extends Error {
  constructor() {
    super("SESSION_CHANGED");
  }
}
export interface SessionStore {
  create(): { sid: string; context: SessionContext };
  get(sid: string): SessionContext | null;
  cas(
    sid: string,
    revision: string,
    change: (context: SessionContext) => void,
    attemptId?: string,
  ): SessionContext;
  close(): void;
}
export const newRevision = () => randomBytes(32).toString("hex");
const hash = (sid: string) => createHash("sha256").update(sid).digest("hex");
const clone = <T>(v: T): T => structuredClone(v);
export interface StoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxContexts?: number;
  maxFileBytes?: number;
}
export interface FileStoreOptions extends StoreOptions {
  path: string;
  encryptionKey: string;
}
const writers = new Set<string>();
/** All RMW including disk persistence is synchronous: never await within a transaction. */
class Store implements SessionStore {
  private data: Record<string, SessionContext> = {};
  private poisoned = false;
  private closed = false;
  private writing = false;
  private now: () => number;
  private ttl: number;
  private cap: number;
  private maxBytes: number;
  private path?: string;
  private key?: Buffer;
  constructor(options: StoreOptions, file?: FileStoreOptions) {
    this.now = options.now ?? Date.now;
    this.ttl = options.ttlMs ?? 30 * 24 * 3600000;
    this.cap = options.maxContexts ?? 1000;
    this.maxBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.ttl) ||
      this.ttl <= 0 ||
      !Number.isSafeInteger(this.cap) ||
      this.cap <= 0 ||
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 128
    )
      throw new SessionStoreError();
    if (file) {
      if (!/^[a-f0-9]{64}$/i.test(file.encryptionKey))
        throw new SessionStoreError();
      this.path = resolve(file.path);
      this.key = Buffer.from(file.encryptionKey, "hex");
      if (writers.has(this.path)) throw new SessionStoreError();
      try {
        this.checkPath(true);
        if (existsSync(this.path)) {
          const fd = openSync(
            this.path,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const st = fstatSync(fd);
            this.checkFile(st);
            if (st.size > this.maxBytes) throw new SessionStoreError();
            const raw = readFileSync(fd);
            if (raw.length < 33 || raw[0] !== 1) throw new SessionStoreError();
            const decipher = createDecipheriv(
              "aes-256-gcm",
              this.key,
              raw.subarray(1, 13),
            );
            decipher.setAAD(Buffer.from("ibs-bff-session-v1"));
            decipher.setAuthTag(raw.subarray(13, 29));
            const value: unknown = JSON.parse(
              Buffer.concat([
                decipher.update(raw.subarray(29)),
                decipher.final(),
              ]).toString("utf8"),
            );
            this.validate(value);
            this.data = value as Record<string, SessionContext>;
          } finally {
            closeSync(fd);
          }
        }
        writers.add(this.path);
      } catch {
        throw new SessionStoreError();
      }
    }
  }
  private checkFile(st: Stats) {
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.nlink !== 1 ||
      (st.mode & 0o777) !== 0o600 ||
      (process.getuid && st.uid !== process.getuid())
    )
      throw new SessionStoreError();
  }
  private checkPath(create = false) {
    const path = this.path!;
    const parent = dirname(path);
    const root = parse(parent).root;
    let at = root;
    for (const part of parent.slice(root.length).split("/").filter(Boolean)) {
      at = join(at, part);
      if (!existsSync(at)) {
        if (!create) throw new SessionStoreError();
        mkdirSync(at, { mode: 0o700 });
      }
      const st = lstatSync(at);
      if (st.isSymbolicLink() || !st.isDirectory())
        throw new SessionStoreError();
    }
    const st = lstatSync(parent);
    if (
      (st.mode & 0o777) !== 0o700 ||
      (process.getuid && st.uid !== process.getuid())
    )
      throw new SessionStoreError();
    // lstat, unlike exists, also detects dangling symlinks.
    try {
      this.checkFile(lstatSync(path));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  private validate(value: unknown) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length > this.cap
    )
      throw new SessionStoreError();
    for (const [k, c] of Object.entries(value)) {
      if (
        !/^[a-f0-9]{64}$/.test(k) ||
        !c ||
        typeof c !== "object" ||
        !/^[a-f0-9]{64}$/.test(c.authRevision) ||
        !Number.isFinite(c.expiresAt) ||
        (c.attemptId !== null && !/^[a-f0-9]{64}$/.test(c.attemptId))
      )
        throw new SessionStoreError();
      if (c.auth !== null) {
        const a = c.auth;
        if (
          !a ||
          typeof a !== "object" ||
          typeof a.accessToken !== "string" ||
          !a.accessToken ||
          typeof a.refreshToken !== "string" ||
          !a.refreshToken ||
          !Number.isFinite(a.expiresAt) ||
          (a.needsVerification !== undefined &&
            typeof a.needsVerification !== "boolean") ||
          !a.user ||
          typeof a.user.id !== "string" ||
          typeof a.user.displayName !== "string"
        )
          throw new SessionStoreError();
      }
    }
  }
  private assert() {
    if (this.poisoned || this.closed) throw new SessionStoreError();
  }
  private transaction<T>(
    mutate: (next: Record<string, SessionContext>) => T,
  ): T {
    this.assert();
    if (this.writing) throw new SessionStoreError();
    this.writing = true;
    let temp: string | undefined;
    try {
      const next = clone(this.data);
      const result = mutate(next);
      this.validate(next);
      const plain = Buffer.from(JSON.stringify(next));
      if (plain.length + 29 > this.maxBytes) throw new SessionStoreError();
      if (this.path) {
        this.checkPath();
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key!, iv);
        cipher.setAAD(Buffer.from("ibs-bff-session-v1"));
        const ciphertext = Buffer.concat([
          cipher.update(plain),
          cipher.final(),
        ]);
        const raw = Buffer.concat([
          Buffer.from([1]),
          iv,
          cipher.getAuthTag(),
          ciphertext,
        ]);
        temp = this.path + "." + randomBytes(12).toString("hex") + ".tmp";
        const fd = openSync(
          temp,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          writeFileSync(fd, raw);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temp, this.path);
        temp = undefined;
        const dir = openSync(
          dirname(this.path),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      }
      // Do not publish callback-retained draft references.
      this.data = clone(next);
      return clone(result);
    } catch (e) {
      if (!(e instanceof SessionChangedError)) {
        this.poisoned = true;
        throw new SessionStoreError();
      }
      throw e;
    } finally {
      this.writing = false;
      if (temp)
        try {
          unlinkSync(temp);
        } catch {
          /* fail closed */
        }
    }
  }
  create() {
    const sid = newRevision();
    const context: SessionContext = {
      authRevision: newRevision(),
      attemptId: null,
      auth: null,
      expiresAt: this.now() + this.ttl,
    };
    return this.transaction((next) => {
      for (const [k, c] of Object.entries(next))
        if (c.expiresAt <= this.now()) delete next[k];
      if (Object.keys(next).length >= this.cap) throw new SessionChangedError();
      next[hash(sid)] = context;
      return { sid, context };
    });
  }
  get(sid: string) {
    this.assert();
    if (!/^[a-f0-9]{64}$/.test(sid)) return null;
    const c = this.data[hash(sid)];
    return c && c.expiresAt > this.now() ? clone(c) : null;
  }
  cas(
    sid: string,
    revision: string,
    change: (context: SessionContext) => void,
    attemptId?: string,
  ) {
    return this.transaction((next) => {
      const c = next[hash(sid)];
      if (
        !c ||
        c.expiresAt <= this.now() ||
        c.authRevision !== revision ||
        (attemptId !== undefined && c.attemptId !== attemptId)
      )
        throw new SessionChangedError();
      const returned: unknown = change(c);
      if (returned !== undefined) {
        // A programmer-supplied async mutator is invalid, but drain its rejection.
        if (returned instanceof Promise) void returned.catch(() => {});
        throw new SessionStoreError();
      }
      return c;
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.path) writers.delete(this.path);
  }
}
export const createMemorySessionStore = (
  options: StoreOptions = {},
): SessionStore => new Store(options);
export const createFileSessionStore = (
  options: FileStoreOptions,
): SessionStore => new Store(options, options);
