import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = resolve(process.env.IBS_EVIDENCE_DIR || resolve(root, "../ibs-marker-verification/watercolor-ui/e/dev"));
export default defineConfig({
  testDir: fileURLToPath(new URL("./", import.meta.url)),
  testMatch: "watercolor-ui.spec.ts", workers: 1, fullyParallel: false,
  timeout: 45000, expect: { timeout: 10000 },
  outputDir: resolve(evidence, "playwright-results"),
  reporter: [["list"], ["json", { outputFile: resolve(evidence, "playwright.json") }]],
  use: { baseURL: "http://127.0.0.1:15008", headless: true, serviceWorkers: "block",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { cwd: root,
    command: "node node_modules/vite/bin/vite.js --config e2e/invite.vite.config.ts --host 127.0.0.1 --port 15008 --strictPort",
    url: "http://127.0.0.1:15008", reuseExistingServer: false,
    env: { VITE_APP_MODE: "local" }, timeout: 30000 },
});
