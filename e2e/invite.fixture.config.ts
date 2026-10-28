import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
const evidence = resolve(process.env.IBS_EVIDENCE_DIR || "test-results/bff-fixtures");
export default defineConfig({
  testDir: ".", testMatch: ["invite.spec.ts", "session.spec.ts", "bootstrap.spec.ts", "offline.spec.ts", "recovery.spec.ts"],
  workers: 1, fullyParallel: false, timeout: 60000, expect: { timeout: 15000 },
  outputDir: resolve(evidence, "playwright-results"),
  reporter: [["list"], ["json", { outputFile: resolve(evidence, "playwright.json") }]],
  use: { baseURL: "http://127.0.0.1:15007", headless: true, serviceWorkers: "block",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "npm run dev -- --config e2e/invite.vite.config.ts --host 127.0.0.1 --port 15007 --strictPort",
    url: "http://127.0.0.1:15007", reuseExistingServer: false, env: { VITE_APP_MODE: "backend" } },
});
