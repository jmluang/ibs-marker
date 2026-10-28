import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { createApplication } from "../server/app.ts";
import { createCurlJsonRequest } from "../server/curlTransport.ts";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
/** CLI-only loading. Importing this module never reads env files or listens. */
export async function loadRuntimeConfig(
  root = defaultRoot,
  environment = process.env,
) {
  const read = async (name) => {
    try {
      return parseEnv(await readFile(resolve(root, name), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw new Error("SERVER_CONFIGURATION_INVALID");
    }
  };
  const privateEnv = { ...(await read(".env")), ...environment };
  const portText = privateEnv.APP_PORT ?? "15001";
  if (portText !== "15001") throw new Error("SERVER_PORT_MUST_BE_15001");
  const host = privateEnv.APP_HOST ?? "10.21.1.227";
  if (!isIP(host)) throw new Error("SERVER_HOST_INVALID");
  const trustedProxyIPs = (privateEnv.TRUSTED_PROXY_IPS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (trustedProxyIPs.some((ip) => !isIP(ip)))
    throw new Error("SERVER_PROXY_CONFIG_INVALID");
  const publicSignupMode = privateEnv.ALLOW_PROVIDER_PUBLIC_SIGNUP;
  if (
    publicSignupMode !== undefined &&
    publicSignupMode !== "true" &&
    publicSignupMode !== "false"
  )
    throw new Error("SERVER_PUBLIC_SIGNUP_MODE_INVALID");
  if (!/^[a-f0-9]{64}$/i.test(privateEnv.SESSION_ENCRYPTION_KEY ?? ""))
    throw new Error("SERVER_SESSION_KEY_INVALID");
  const config = {
    sessionEncryptionKey: privateEnv.SESSION_ENCRYPTION_KEY,
    serverSessionFile: resolve(
      root,
      privateEnv.SESSION_STORE_PATH ?? ".private/bff-sessions.enc",
    ),
    allowProviderPublicSignup: publicSignupMode === "true",
    host,
    port: 15001,
    publicOrigin: privateEnv.PUBLIC_ORIGIN ?? "",
    additionalOrigins: (privateEnv.DEV_ORIGINS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    trustedProxyIPs,
    inviteCode: privateEnv.INVITE_CODE ?? "",
    supabaseUrl: privateEnv.SUPABASE_URL ?? "",
    supabasePublicKey:
      privateEnv.SUPABASE_PUBLISHABLE_KEY || privateEnv.SUPABASE_ANON_KEY || "",
    supabaseSecretKey: privateEnv.SUPABASE_SECRET_KEY ?? "",
    supabaseAccessToken: privateEnv.SUPABASE_ACCESS_TOKEN ?? "",
    supabaseProjectRef: privateEnv.SUPABASE_PROJECT_REF,
    distDir: resolve(root, "dist"),
  };
  return config;
}
export async function startServer(config) {
  const allowedOrigins = ["https://api.supabase.com"];
  try {
    const u = new URL(config.supabaseUrl);
    if (u.protocol === "https:" && u.href === u.origin + "/")
      allowedOrigins.push(u.origin);
  } catch {
    /* app remains preparing */
  }
  const server = createApplication(
    config,
    createCurlJsonRequest({ allowedOrigins }),
  );
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      accept();
    });
  });
  return server;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const config = await loadRuntimeConfig();
    const server = await startServer(config);
    console.log(
      "Server listening (readiness is independently verified at /readyz)",
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        server.close(() => process.exit(0));
        server.closeAllConnections();
      });
  } catch {
    console.error("SERVER_START_FAILED");
    process.exitCode = 1;
  }
}
