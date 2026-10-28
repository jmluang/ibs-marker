import { defineConfig } from "@playwright/test";
import config from "./invite.fixture.config";
// API-offline/local metadata fixture. Production Node/SW acceptance is separate.
export default defineConfig({ ...config, testMatch: "offline.spec.ts" });
