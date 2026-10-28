import { defineConfig } from "@playwright/test";
import config from "./invite.fixture.config";
export default defineConfig({ ...config, testMatch: ["tracker.spec.ts", "edge.spec.ts"],
  webServer: { command: "npm run dev -- --config e2e/invite.vite.config.ts --host 127.0.0.1 --port 15007 --strictPort",
    url: "http://127.0.0.1:15007", reuseExistingServer: false, env: { VITE_APP_MODE: "local" } },
});
