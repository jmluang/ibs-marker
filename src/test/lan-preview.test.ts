import { describe, expect, it } from "vitest";
// The preview entry point is intentionally plain Node ESM.
// @ts-expect-error JavaScript CLI has no generated declarations.
import { isAllowedAddress, requireLanSource } from "../../scripts/preview-lan.mjs";

describe("LAN socket source ACL", () => {
  it("allows only the exact IPv4 /24, including mapped IPv4 peers", () => {
    for (const peer of ["10.21.1.0", "10.21.1.1", "10.21.1.227", "10.21.1.255", "::ffff:10.21.1.8"])
      expect(isAllowedAddress(peer)).toBe(true);
    for (const peer of [undefined, "", "127.0.0.1", "::1", "10.21.0.1", "10.21.2.1", "10.21.10.1", "172.17.0.1", "10.21.1.256", "10.21.1.1.attacker", "::ffff:172.17.0.1", "2001:db8::1"])
      expect(isAllowedAddress(peer)).toBe(false);
  });
  it("denies spoofed forwarding and Host headers for every path", () => {
    for (const url of ["/", "/assets/app.js", "/sw.js", "/manifest.webmanifest", "/some/spa/route"])
      for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
        let status = 0;
        let body = "";
        let continued = false;
        requireLanSource({ url, method, socket: { remoteAddress: "172.17.0.1" }, headers: { host: "10.21.1.227", "x-forwarded-for": "10.21.1.2", forwarded: "for=10.21.1.2", "x-real-ip": "10.21.1.2" } }, {
          writeHead(code: number) { status = code; },
          end(value: string) { body = value; },
        }, () => { continued = true; });
        expect(status).toBe(403);
        expect(body).toBe("Forbidden\n");
        expect(continued).toBe(false);
      }
  });
  it("passes allowed socket peers to the next middleware", () => {
    let continued = false;
    requireLanSource({ socket: { remoteAddress: "10.21.1.2" } }, {}, () => { continued = true; });
    expect(continued).toBe(true);
  });
});
