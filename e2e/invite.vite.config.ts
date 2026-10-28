import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// Independent fixture: never read .env, proxy APIs, or expose inherited provider env.
export default defineConfig({ envDir: false, envPrefix: ["VITE_APP_MODE"], plugins: [react(), tailwindcss()] });
