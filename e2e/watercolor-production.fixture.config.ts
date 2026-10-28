import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = resolve(process.env.IBS_EVIDENCE_DIR || resolve(root, "../ibs-marker-verification/watercolor-ui/e/production"));
export default defineConfig({
  testDir: fileURLToPath(new URL("./", import.meta.url)),
  testMatch: "watercolor-production.spec.ts", workers: 1, fullyParallel: false,
  timeout: 60000, expect: { timeout: 15000 },
  outputDir: resolve(evidence, "playwright-results"),
  reporter: [["list"], ["json", { outputFile: resolve(evidence, "playwright.json") }]],
  use: { baseURL: "http://127.0.0.1:15009", headless: true, serviceWorkers: "allow",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { cwd: root, command: "node e2e/watercolor-production.server.mjs",
    url: "http://127.0.0.1:15009/readyz", reuseExistingServer: false, timeout: 30000,
    env: { WATERCOLOR_DIST_DIR: process.env.WATERCOLOR_DIST_DIR || "/home/luang/ibs-marker-verification/watercolor-ui/release/dist" } },
});
