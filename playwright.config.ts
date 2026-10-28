import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const evidence = process.env.IBS_EVIDENCE_DIR || resolve("test-results");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const partialCloud = Boolean(process.env.UI_E2E_CLOUD_BOOTSTRAP);
const rawPort = process.env.UI_E2E_PORT ?? "15004";
if (!/^[0-9]+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
  throw new Error("UI_E2E_PORT must be an integer between 1 and 65535");
}
const port = Number(rawPort);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./e2e",
  testMatch: partialCloud
    ? "bootstrap.spec.ts"
    : process.env.UI_E2E_PRODUCTION
      ? "offline.spec.ts"
      : ["tracker.spec.ts", "edge.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL,
    headless: true,
    launchOptions: executablePath ? { executablePath } : {},
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  outputDir: resolve(evidence, "playwright-results"),
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(evidence, "playwright-report.json") }],
  ],
  webServer: {
    command: process.env.UI_E2E_PRODUCTION
      ? `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`
      : `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30000,
    env: { VITE_APP_MODE: partialCloud || process.env.UI_E2E_PRODUCTION ? "backend" : "local" },
  },
});
