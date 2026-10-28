import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const origin = "https://shell.fixture.invalid";
function worker(network: () => Promise<Response>, shell: Response | undefined = new Response("cached shell", { headers: { "content-type": "text/html" } })) {
  const handlers = new Map<string, (event: unknown) => void>();
  const put = vi.fn();
  const match = vi.fn(async (key: string) => key === "/index.html" ? shell : undefined);
  const fetch = vi.fn(network);
  runInNewContext(source, {
    self: { location: new URL(`${origin}/sw.js?build=fixture`), addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) },
    URL, Response, fetch, caches: { open: vi.fn(async () => ({ match, put })) },
  });
  function dispatch(path: string, options: { mode?: string; method?: string } = {}) {
    let response: Promise<Response> | undefined;
    handlers.get("fetch")!({ request: { url: new URL(path, origin).href, method: options.method ?? "GET", mode: options.mode ?? "navigate" }, respondWith: (value: Promise<Response>) => { response = value; } });
    return response;
  }
  return { dispatch, fetch, put, match };
}

describe("known UI document navigation only", () => {
  for (const path of ["/", "/?x=1", "/index.html", "/index.html?x=1"]) {
    for (const [label, network] of [
      ["HTTP JSON error", async () => new Response('{"code":"FORBIDDEN"}', { status: 403, headers: { "content-type": "application/json" } })],
      ["unavailable JSON error", async () => new Response('{"code":"AUTH_UNAVAILABLE"}', { status: 503, headers: { "content-type": "application/json" } })],
      ["successful non-HTML", async () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } })],
      ["HTTP HTML error", async () => new Response("server error", { status: 500, headers: { "content-type": "text/html" } })],
      ["network exception", async () => { throw new TypeError("offline"); }],
    ] as const) {
      it(`${path} uses known cached shell after ${label} without caching the body`, async () => {
        const sw = worker(network);
        const response = sw.dispatch(path);
        expect(response).toBeDefined();
        expect(await (await response!).text()).toBe("cached shell");
        expect(sw.put).not.toHaveBeenCalled();
        expect(sw.match.mock.calls.every(([key]) => key === "/index.html" || key === "/")).toBe(true);
      });
    }
    it(`${path} passes successful network HTML through unchanged`, async () => {
      const html = new Response("fresh shell", { headers: { "content-type": "text/html; charset=utf-8" } });
      const sw = worker(async () => html);
      expect(await sw.dispatch(path)).toBe(html);
      expect(sw.match).not.toHaveBeenCalled();
      expect(sw.put).not.toHaveBeenCalled();
    });
  }
  for (const path of ["/api", "/api/auth/session", "/api/auth/session?x=1", "/auth", "/auth/callback", "/rest", "/rest/v1/data", "/private", "/.private/secrets", "/history", "/unknown?x=1", "/assets/app.js", "/sw.js?build=wrong", "https://foreign.fixture.invalid/"]) {
    it(`does not intercept document ${path}`, () => {
      const sw = worker(async () => { throw new Error("must not fetch"); });
      expect(sw.dispatch(path)).toBeUndefined();
      expect(sw.fetch).not.toHaveBeenCalled();
      expect(sw.match).not.toHaveBeenCalled();
      expect(sw.put).not.toHaveBeenCalled();
    });
  }
  it("never intercepts API/auth/rest fetch requests, with or without query", () => {
    const sw = worker(async () => new Response("must not be fetched"));
    for (const path of ["/api", "/api/auth/session", "/api/auth/session?x=1", "/auth/callback", "/rest/v1/data"]) {
      expect(sw.dispatch(path, { mode: "cors" })).toBeUndefined();
      expect(sw.dispatch(path, { mode: "same-origin" })).toBeUndefined();
    }
    expect(sw.fetch).not.toHaveBeenCalled();
    expect(sw.put).not.toHaveBeenCalled();
  });
  it("does not intercept non-GET or queried static assets", () => {
    const sw = worker(async () => new Response("unused"));
    expect(sw.dispatch("/", { method: "POST" })).toBeUndefined();
    expect(sw.dispatch("/assets/app.js?x=1", { mode: "cors" })).toBeUndefined();
    expect(sw.dispatch("/sw.js?build=wrong", { mode: "cors" })).toBeUndefined();
    expect(sw.fetch).not.toHaveBeenCalled();
  });
  it("does not turn a missing cached shell into a JSON response", async () => {
    const sw = worker(async () => new Response('{"code":"FORBIDDEN"}', { status: 403 }), undefined);
    // Explicit absence, rather than the helper's default shell.
    sw.match.mockResolvedValue(undefined);
    const response = await sw.dispatch("/?x=1");
    expect(response?.type).toBe("error");
    expect(sw.put).not.toHaveBeenCalled();
  });
  it("does not cache a static HTTP error body", async () => {
    const sw = worker(async () => new Response('{"code":"UNAVAILABLE"}', { status: 503 }));
    expect((await sw.dispatch("/assets/app.js", { mode: "cors" }))?.status).toBe(503);
    expect(sw.put).not.toHaveBeenCalled();
  });
});
