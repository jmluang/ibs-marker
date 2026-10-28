import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface JsonRequestInput {
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}
export type JsonRequest = (
  request: JsonRequestInput,
) => Promise<{ status: number; body: unknown }>;
export interface CurlOptions {
  allowedOrigins: readonly string[];
  interfaceName?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawnProcess?: typeof spawn;
}
const safeError = () => new Error("UPSTREAM_TRANSPORT_FAILED");
function quote(value: string): string {
  return (
    '"' +
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t")
      .replace(/\v/g, "\\v") +
    '"'
  );
}
function httpsOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      value !== url.origin ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw safeError();
    return url.origin;
  } catch {
    throw safeError();
  }
}
/** Secrets are sent exclusively through curl's stdin config, never argv/env/shell. */
export function createCurlJsonRequest(options: CurlOptions): JsonRequest {
  if (
    !Array.isArray(options.allowedOrigins) ||
    options.allowedOrigins.length === 0
  )
    throw safeError();
  const origins = new Set(options.allowedOrigins.map(httpsOrigin));
  const device = options.interfaceName ?? "enp0s31f6";
  if (!/^[a-zA-Z0-9_.:-]{1,32}$/.test(device)) throw safeError();
  const timeoutMs = options.timeoutMs ?? 12000;
  const maxOutput = options.maxOutputBytes ?? 1024 * 1024;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxOutput) ||
    maxOutput <= 0
  )
    throw safeError();
  return async (input) => {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw safeError();
    }
    if (
      url.protocol !== "https:" ||
      !origins.has(url.origin) ||
      url.username ||
      url.password ||
      url.hash ||
      !["GET", "POST", "PATCH", "DELETE", "PUT"].includes(input.method)
    )
      throw safeError();
    const lines = [
      'header = "Content-Type: application/json"',
      'header = "Accept: application/json"',
    ];
    for (const [key, value] of Object.entries(input.headers ?? {})) {
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
        /[\x00-\x1f\x7f]/.test(value) ||
        /^(host|content-length|transfer-encoding|proxy-authorization)$/i.test(
          key,
        )
      )
        throw safeError();
      lines.push(`header = ${quote(key + ": " + value)}`);
    }
    if (input.body !== undefined) {
      let body: string | undefined;
      try {
        body = JSON.stringify(input.body);
      } catch {
        throw safeError();
      }
      if (body === undefined || Buffer.byteLength(body) > 1024 * 1024)
        throw safeError();
      lines.push(`data-binary = ${quote(body)}`);
    }
    if (input.signal?.aborted) throw safeError();
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = (options.spawnProcess ?? spawn)(
          "curl",
          [
            "-q",
            "--config",
            "-",
            "--silent",
            "--show-error",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--max-redirs",
            "0",
            "--noproxy",
            "*",
            "--interface",
            `if!${device}`,
            "--connect-timeout",
            String(Math.min(5, timeoutMs / 1000)),
            "--max-time",
            String(timeoutMs / 1000),
            "--max-filesize",
            String(maxOutput),
            "--write-out",
            "\n%{http_code}",
            "--request",
            input.method,
            "--url",
            url.href,
          ],
          {
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            env: { PATH: "/usr/bin:/bin", LANG: "C" },
          },
        ) as ChildProcessWithoutNullStreams;
      } catch {
        reject(safeError());
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const done = (
        error?: Error,
        result?: { status: number; body: unknown },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        if (error) {
          child.kill("SIGKILL");
          reject(safeError());
        } else resolve(result!);
      };
      const abort = () => done(safeError());
      const timer = setTimeout(abort, timeoutMs + 250);
      timer.unref();
      input.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxOutput + 4) done(safeError());
        else chunks.push(chunk);
      });
      // Drain but never retain or print curl's diagnostics (they may contain URLs/data).
      child.stderr.on("data", () => {});
      child.on("error", () => done(safeError()));
      child.stdin.on("error", () => done(safeError()));
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          done(safeError());
          return;
        }
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const split = raw.lastIndexOf("\n");
          const statusText = raw.slice(split + 1);
          const status = Number(statusText);
          if (split < 0 || !/^[1-5]\d\d$/.test(statusText)) throw safeError();
          const text = raw.slice(0, split);
          done(undefined, { status, body: text ? JSON.parse(text) : null });
        } catch {
          done(safeError());
        }
      });
      child.stdin.end(lines.join("\n") + "\n");
    });
  };
}
