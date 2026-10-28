export type CloudConfig =
  | { state: "absent" }
  | { state: "invalid"; message: string }
  | { state: "ready" };
/** Production always uses the same-origin backend; no provider configuration. */
export function readCloudConfig(env: Record<string, unknown>): CloudConfig {
  return env.VITE_APP_MODE === "local" && env.PROD !== true
    ? { state: "absent" }
    : { state: "ready" };
}
