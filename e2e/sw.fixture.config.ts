import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
const evidence = resolve(process.env.IBS_EVIDENCE_DIR || "test-results/sw-fixtures");
export default defineConfig({
  testDir: ".", testMatch: "sw-navigation.spec.ts", workers: 1, fullyParallel: false,
  timeout: 30000, expect: { timeout: 10000 },
  outputDir: resolve(evidence, "playwright-results"),
  reporter: [["list"], ["json", { outputFile: resolve(evidence, "playwright.json") }]],
  use: { baseURL: "http://127.0.0.1:15007", headless: true, serviceWorkers: "allow",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "node sw.fixture.server.mjs", url: "http://127.0.0.1:15007", reuseExistingServer: false },
});
