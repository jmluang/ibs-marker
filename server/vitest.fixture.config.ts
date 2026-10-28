import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
/** Backend fixtures must never load the checkout's real .env/.env.local. */
export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  envDir: false,
  test: {
    environment: "node",
    include: ["src/test/server-*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
