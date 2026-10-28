import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

export function createOfflineManifest(
  buildId: string,
  bundleFiles: string[],
  publicFiles: string[],
) {
  const assets = [
    "/",
    "/index.html",
    ...bundleFiles
      .filter(
        (file) =>
          !file.endsWith(".map") &&
          file !== "sw.js" &&
          file !== "asset-manifest.json",
      )
      .map((file) => `/${file}`),
    ...publicFiles,
  ];
  return { buildId, assets: [...new Set(assets)] };
}

/** Static application files only. This never lists IndexedDB, auth responses, or remote APIs. */
export function offlineManifest(buildId: string): Plugin {
  return {
    name: "ibs-marker-offline-manifest",
    enforce: "post",
    apply: "build",
    generateBundle(_options, bundle) {
      const publicFiles = [
        "icon.svg",
        "favicon.svg",
        "icon-192.png",
        "icon-512.png",
        "stool-forms.svg",
        "manifest.webmanifest",
      ]
        .filter((file) => existsSync(resolve(process.cwd(), "public", file)))
        .map((file) => `/${file}`);
      this.emitFile({
        type: "asset",
        fileName: "asset-manifest.json",
        source: JSON.stringify(
          createOfflineManifest(buildId, Object.keys(bundle), publicFiles),
        ),
      });
    },
  };
}
