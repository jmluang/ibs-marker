import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { offlineManifest } from "./build/offlineManifest.ts";
import { backendOnlyFrontend } from "./build/backendBoundary.ts";
const buildId = Date.now().toString(36);
export default defineConfig({
  envDir: false,
  // Cloud credentials/configuration are server-only, including formerly public keys.
  envPrefix: "VITE_APP_",
  define: { "import.meta.env.VITE_BUILD_ID": JSON.stringify(buildId) },
  plugins: [react(), tailwindcss(), backendOnlyFrontend(), offlineManifest(buildId)],
  test: {
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["**/node_modules/**", "**/e2e/**"],
  },
});
