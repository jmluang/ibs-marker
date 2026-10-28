import { describe, expect, it } from "vitest";
import { createOfflineManifest } from "../../build/offlineManifest";

describe("offline shell manifest", () => {
  it("contains the actual generated bundle names and only explicit public assets", () => {
    const manifest = createOfflineManifest(
      "test-build",
      ["assets/index-realHash.js", "assets/index-realHash.css"],
      ["/icon-192.png"],
    );
    expect(manifest).toEqual({
      buildId: "test-build",
      assets: [
        "/",
        "/index.html",
        "/assets/index-realHash.js",
        "/assets/index-realHash.css",
        "/icon-192.png",
      ],
    });
    expect(
      manifest.assets.some(
        (asset) =>
          asset.includes("supabase") ||
          asset.includes("/api/") ||
          asset.includes(".env"),
      ),
    ).toBe(false);
  });
  it("excludes worker/self-manifest/source maps and removes duplicate static URLs", () => {
    const manifest = createOfflineManifest(
      "b",
      ["index.html", "sw.js", "asset-manifest.json", "assets/app.js.map"],
      ["/index.html", "/icon.svg", "/icon.svg"],
    );
    expect(manifest.assets).toEqual(["/", "/index.html", "/icon.svg"]);
  });
});
