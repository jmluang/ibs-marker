import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { createCurlJsonRequest } from "../../server/curlTransport.ts";
const origins = ["https://fixture.supabase.co", "https://api.supabase.com"];
function fakeProcess(output = '{"fixture":true}\n200', exit = 0) {
  let stdin = "";
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  child.stdin.on("data", (c) => {
    stdin += c.toString();
  });
  child.stdin.on("finish", () => {
    queueMicrotask(() => {
      child.stdout.write(output);
      child.stderr.write("private provider diagnostic");
      child.emit("close", exit);
    });
  });
  const spawner = vi.fn(() => child);
  return {
    child,
    spawner,
    spawnProcess: spawner as unknown as typeof spawn,
    get stdin() {
      return stdin;
    },
  };
}
describe("safe curl stdin transport", () => {
  it("keeps all credentials/body exclusively in stdin; binds physical device and verifies TLS", async () => {
    const fake = fakeProcess();
    const send = createCurlJsonRequest({
      allowedOrigins: origins,
      spawnProcess: fake.spawnProcess,
    });
    expect(
      await send({
        method: "POST",
        url: origins[0] + "/auth/v1/admin/users",
        headers: { Authorization: "Bearer SECRET-TEST", apikey: "KEY-TEST" },
        body: { password: "PASSWORD-TEST", invite: 'quote"slash\\newline\n' },
      }),
    ).toEqual({ status: 200, body: { fixture: true } });
    const [bin, args, options] = fake.spawner.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(bin).toBe("curl");
    expect(args.slice(0, 3)).toEqual(["-q", "--config", "-"]);
    expect(args).toContain("if!enp0s31f6");
    expect(args).toContain("--noproxy");
    expect(args).not.toContain("--insecure");
    expect(args).not.toContain("--location");
    expect(args.join(" ")).not.toMatch(/SECRET-TEST|KEY-TEST|PASSWORD-TEST/);
    expect(options.shell).toBe(false);
    expect(options.env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C" });
    expect(fake.stdin).toContain(
      'header = "Authorization: Bearer SECRET-TEST"\n',
    );
    expect(fake.stdin).toContain('header = "apikey: KEY-TEST"\n');
    const data = fake.stdin
      .split("\n")
      .find((line) => line.startsWith("data-binary = "))!;
    const configQuoted = data.slice("data-binary = ".length);
    expect(JSON.parse(JSON.parse(configQuoted))).toEqual({
      password: "PASSWORD-TEST",
      invite: 'quote"slash\\newline\n',
    });
  });
  it.each([
    "http://fixture.supabase.co/a",
    "https://fixture.supabase.co.evil/a",
    "https://evil.test",
    "https://secret@fixture.supabase.co/a",
    "https://fixture.supabase.co/a#secret",
  ])("blocks SSRF URL %s before spawn", async (url) => {
    const fake = fakeProcess();
    const send = createCurlJsonRequest({
      allowedOrigins: origins,
      spawnProcess: fake.spawnProcess,
    });
    await expect(send({ method: "GET", url })).rejects.toThrow(
      "UPSTREAM_TRANSPORT_FAILED",
    );
    expect(fake.spawner).not.toHaveBeenCalled();
  });
  it("requires nonempty exact HTTPS origins", () => {
    expect(() => createCurlJsonRequest({ allowedOrigins: [] })).toThrow();
    expect(() =>
      createCurlJsonRequest({ allowedOrigins: ["http://localhost"] }),
    ).toThrow();
    expect(() =>
      createCurlJsonRequest({
        allowedOrigins: ["https://fixture.supabase.co/"],
      }),
    ).toThrow();
  });
  it("blocks header/config injection", async () => {
    const fake = fakeProcess();
    const send = createCurlJsonRequest({
      allowedOrigins: origins,
      spawnProcess: fake.spawnProcess,
    });
    await expect(
      send({
        method: "GET",
        url: origins[0],
        headers: { Authorization: 'secret\nurl = "https://evil.test"' },
      }),
    ).rejects.toThrow("UPSTREAM_TRANSPORT_FAILED");
    expect(fake.spawner).not.toHaveBeenCalled();
  });
  it.each([
    ["private body\n302", 0],
    ['{"secret":"PRIVATE"}\n200', 7],
    ["not-json\n200", 0],
  ])(
    "returns only safe errors for provider/process failure %s",
    async (output, exit) => {
      const fake = fakeProcess(output, exit);
      const send = createCurlJsonRequest({
        allowedOrigins: origins,
        spawnProcess: fake.spawnProcess,
      });
      await expect(send({ method: "GET", url: origins[0] })).rejects.toThrow(
        /^UPSTREAM_TRANSPORT_FAILED$/,
      );
    },
  );
  it("enforces maximum output", async () => {
    const fake = fakeProcess("x".repeat(1000) + "\n200");
    const send = createCurlJsonRequest({
      allowedOrigins: origins,
      maxOutputBytes: 100,
      spawnProcess: fake.spawnProcess,
    });
    await expect(send({ method: "GET", url: origins[0] })).rejects.toThrow(
      "UPSTREAM_TRANSPORT_FAILED",
    );
    expect(fake.child.kill).toHaveBeenCalled();
  });
  it("supports explicit cancellation and timeout", async () => {
    const fake = fakeProcess();
    fake.child.stdin.removeAllListeners("finish");
    const controller = new AbortController();
    const send = createCurlJsonRequest({
      allowedOrigins: origins,
      timeoutMs: 10,
      spawnProcess: fake.spawnProcess,
    });
    const pending = send({
      method: "GET",
      url: origins[0],
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("UPSTREAM_TRANSPORT_FAILED");
    expect(fake.child.kill).toHaveBeenCalled();
    const timed = send({ method: "GET", url: origins[0] });
    await expect(timed).rejects.toThrow("UPSTREAM_TRANSPORT_FAILED");
  });
});
