import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Resolves against this config, not the shared node_modules symlink or parent cwd.
const root = fileURLToPath(new URL("../", import.meta.url));
const port = process.env.DURATION_E2E_PORT ?? "15012";
if (!["15012", "15014"].includes(port)) throw Error("Use isolated duration port 15012 or 15014");
const origin = `http://127.0.0.1:${port}`;
const evidence = resolve(process.env.IBS_EVIDENCE_DIR ?? resolve(root, "../ibs-marker-verification/duration-edit/browser"));
export default defineConfig({
  testDir: fileURLToPath(new URL("./", import.meta.url)),
  testMatch: "duration-edit.spec.ts", fullyParallel: false, workers: 1,
  timeout: 45000, expect: { timeout: 3000 }, retries: 0,
  outputDir: resolve(evidence, "results"),
  reporter: [["list"], ["json", { outputFile: resolve(evidence, "playwright.json") }]],
  use: { baseURL: origin, headless: true, serviceWorkers: "block",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
    screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { cwd: root,
    command: `node node_modules/vite/bin/vite.js --config e2e/invite.vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: origin, reuseExistingServer: false, timeout: 30000,
    env: { VITE_APP_MODE: "local", VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" } },
});
