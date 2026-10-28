import { createHash, createDecipheriv } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
  chmodSync,
  mkdirSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import {
  createFileSessionStore,
  createMemorySessionStore,
  newRevision,
  SessionChangedError,
  SessionStoreError,
} from "../../server/sessionStore.ts";
import type { SessionStore } from "../../server/sessionStore.ts";
const dirs: string[] = [];
const stores: SessionStore[] = [];
function file() {
  const dir = mkdtempSync(join(process.env.TMPDIR!, "bff-store-"));
  dirs.push(dir);
  return {
    dir,
    path: join(dir, "sessions.enc"),
    encryptionKey: "ab".repeat(32),
  };
}
function open(options: Parameters<typeof createFileSessionStore>[0]) {
  const s = createFileSessionStore(options);
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const auth = {
  user: { id: "f0000000-0000-4000-8000-000000000001", displayName: "alice" },
  accessToken: "PRIVATE_JWT_FIXTURE",
  refreshToken: "PRIVATE_REFRESH_FIXTURE",
  expiresAt: 9999999999999,
};
it("stores only SID hashes in private AES-GCM file and restores exact CAS generations", () => {
  const f = file();
  let s = open(f);
  const a = s.create();
  s.cas(a.sid, a.context.authRevision, (c) => {
    c.auth = auth;
    c.authRevision = newRevision();
  });
  const current = s.get(a.sid)!;
  const bytes = readFileSync(f.path);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(f.encryptionKey, "hex"),
    bytes.subarray(1, 13),
  );
  decipher.setAAD(Buffer.from("ibs-bff-session-v1"));
  decipher.setAuthTag(bytes.subarray(13, 29));
  const plain = Buffer.concat([
    decipher.update(bytes.subarray(29)),
    decipher.final(),
  ]).toString();
  expect(Object.keys(JSON.parse(plain))).toEqual([
    createHash("sha256").update(a.sid).digest("hex"),
  ]);
  expect(plain).not.toContain(a.sid);
  for (const leak of [
    a.sid,
    auth.accessToken,
    auth.refreshToken,
    "alice",
    current.authRevision,
  ])
    expect(bytes.includes(Buffer.from(leak))).toBe(false);
  expect(statSync(f.path).mode & 0o777).toBe(0o600);
  s.close();
  s = open(f);
  expect(s.get(a.sid)).toEqual(current);
  expect(() =>
    s.cas(a.sid, a.context.authRevision, (c) => {
      c.auth = null;
    }),
  ).toThrow(SessionChangedError);
  expect(s.get(a.sid)).toEqual(current);
  expect(readFileSync(f.path)).toEqual(bytes);
});
it("two concurrent asynchronous contexts never overwrite one another in the single synchronous writer", async () => {
  const f = file();
  let s = open(f);
  const a = s.create(),
    b = s.create();
  await Promise.all([
    Promise.resolve().then(() =>
      s.cas(a.sid, a.context.authRevision, (c) => {
        c.auth = auth;
        c.authRevision = newRevision();
      }),
    ),
    Promise.resolve().then(() =>
      s.cas(b.sid, b.context.authRevision, (c) => {
        c.attemptId = newRevision();
        c.authRevision = newRevision();
      }),
    ),
  ]);
  const ac = s.get(a.sid),
    bc = s.get(b.sid);
  s.close();
  s = open(f);
  expect(s.get(a.sid)).toEqual(ac);
  expect(s.get(b.sid)).toEqual(bc);
  expect(ac?.auth).toEqual(auth);
  expect(bc?.attemptId).toBeTruthy();
});
it.each(["corrupt", "wrong-key", "permissions"])(
  "fails closed on %s without replacing existing bytes",
  (mode) => {
    const f = file();
    const s = open(f);
    s.create();
    s.close();
    if (mode === "corrupt")
      writeFileSync(f.path, Buffer.from("corrupt"), { mode: 0o600 });
    if (mode === "permissions") chmodSync(f.path, 0o644);
    const before = readFileSync(f.path);
    expect(() =>
      open({
        ...f,
        ...(mode === "wrong-key" ? { encryptionKey: "cd".repeat(32) } : {}),
      }),
    ).toThrow(SessionStoreError);
    expect(readFileSync(f.path)).toEqual(before);
  },
);
it("rejects symlinked target and private directory, including dangling links", () => {
  for (const dangling of [false, true]) {
    const f = file();
    const target = join(f.dir, "target");
    if (!dangling) writeFileSync(target, "do-not-touch", { mode: 0o600 });
    symlinkSync(target, f.path);
    expect(() => open(f)).toThrow(SessionStoreError);
  }
  const f = file();
  const real = join(f.dir, "real");
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, join(f.dir, "link"));
  expect(() => open({ ...f, path: join(f.dir, "link", "data") })).toThrow(
    SessionStoreError,
  );
});
it("rejects nonprivate parent and competing writers", () => {
  const f = file();
  chmodSync(f.dir, 0o755);
  expect(() => open(f)).toThrow(SessionStoreError);
  chmodSync(f.dir, 0o700);
  open(f);
  expect(() => open(f)).toThrow(SessionStoreError);
});
it("poisons reads and mutations after disk failure rather than publishing a successful logout", () => {
  const f = file();
  const s = open(f);
  const a = s.create();
  s.cas(a.sid, a.context.authRevision, (c) => {
    c.auth = auth;
  });
  // Replace the target with a directory: deterministic disk error even when CI is root.
  rmSync(f.path);
  mkdirSync(f.path, { mode: 0o700 });
  expect(() =>
    s.cas(a.sid, a.context.authRevision, (c) => {
      c.auth = null;
      c.authRevision = newRevision();
    }),
  ).toThrow(SessionStoreError);
  expect(() => s.get(a.sid)).toThrow(SessionStoreError);
  expect(() => s.create()).toThrow(SessionStoreError);
});
it("expires contexts, bounds count, and never reuses an expired SID", () => {
  let clock = 1000;
  const s = createMemorySessionStore({
    maxContexts: 1,
    ttlMs: 100,
    now: () => clock,
  });
  stores.push(s);
  const a = s.create();
  expect(() => s.create()).toThrow();
  expect(s.get(a.sid)).toEqual(a.context);
  clock = 1100;
  expect(s.get(a.sid)).toBeNull();
  const b = s.create();
  expect(b.sid).not.toBe(a.sid);
  expect(s.get(b.sid)).toEqual(b.context);
});
it("rejects asynchronous mutation callbacks before publishing and poisons the invalid writer", async () => {
  const s = createMemorySessionStore();
  stores.push(s);
  const a = s.create();
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  expect(() =>
    s.cas(a.sid, a.context.authRevision, async (c) => {
      await wait;
      c.auth = auth;
    }),
  ).toThrow(SessionStoreError);
  release();
  await Promise.resolve();
  expect(() => s.get(a.sid)).toThrow(SessionStoreError);
});
it("a callback-retained mutable draft cannot modify the published context later", () => {
  const s = createMemorySessionStore();
  stores.push(s);
  const a = s.create();
  let draft: ReturnType<SessionStore["get"]> = null;
  s.cas(a.sid, a.context.authRevision, (c) => {
    draft = c;
  });
  (draft as unknown as { auth: unknown }).auth = auth;
  expect(s.get(a.sid)?.auth).toBeNull();
});
it("closing an old store twice never releases the new writer after restart", () => {
  const f = file();
  const old = open(f);
  old.create();
  old.close();
  open(f);
  old.close();
  expect(() => open(f)).toThrow(SessionStoreError);
});
it("rejects nested/reentrant mutations instead of overwriting a successful inner commit", () => {
  const s = createMemorySessionStore();
  stores.push(s);
  const a = s.create(),
    b = s.create();
  expect(() =>
    s.cas(a.sid, a.context.authRevision, () => {
      s.cas(b.sid, b.context.authRevision, (c) => {
        c.auth = auth;
      });
    }),
  ).toThrow(SessionStoreError);
  expect(() => s.get(a.sid)).toThrow(SessionStoreError);
});
