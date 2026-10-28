import { describe, it, expect } from "vitest";
import { readCloudConfig } from "../cloud/config";
import { BffTransport } from "../cloud/transport";

describe("same-origin BFF boundary", () => {
  it("defaults to BFF, only explicit nonproduction local mode bypasses login", () => {
    expect(readCloudConfig({})).toEqual({ state: "ready" });
    expect(readCloudConfig({ PROD: true, VITE_APP_MODE: "local" })).toEqual({
      state: "ready",
    });
    expect(readCloudConfig({ VITE_APP_MODE: "local" })).toEqual({
      state: "absent",
    });
    const env = Object.defineProperty({}, "VITE_SUPABASE_URL", {
      get() {
        throw Error("must not read");
      },
    });
    expect(readCloudConfig(env)).toEqual({ state: "ready" });
  });
  it("captures revision, native receiver, credentials and AbortSignal", async () => {
    const signal = new AbortController().signal;
    const calls: Array<[unknown, RequestInit | undefined]> = [];
    const fetcher = function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) {
      expect(this).toBe(globalThis);
      calls.push([input, init]);
      return Promise.resolve(new Response('{"ok":true,"rows":[]}'));
    } as typeof fetch;
    const transport = new BffTransport("revision-A", fetcher);
    expect(await transport.pull(4, 20, signal)).toEqual([]);
    expect(calls).toEqual([
      [
        "/api/sync/pull?cursor=4&limit=20",
        expect.objectContaining({
          credentials: "same-origin",
          signal,
          headers: expect.objectContaining({ "X-Auth-Revision": "revision-A" }),
        }),
      ],
    ]);
  });
  it("maps CAS conflict to engine auth failure, never exposes raw error body", async () => {
    const transport = new BffTransport(
      "A",
      async () =>
        new Response('{"code":"SESSION_CHANGED","message":"secret"}', {
          status: 409,
        }),
    );
    await expect(
      transport.pull(0, 100, new AbortController().signal),
    ).rejects.toMatchObject({ status: 401, code: "SESSION_CHANGED" });
  });
});
