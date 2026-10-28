/** Browser/BFF contract only. Never add provider URLs, keys, tokens or SDK types. */
export interface BackendUser {
  id: string;
  displayName: string;
}
export interface BackendSession {
  ok: true;
  user: BackendUser | null;
  /** Non-credential CAS generation; not a Supabase token or a cookie SID. */
  authRevision: string;
}
export interface BackendPrepare {
  ok: true;
  authRevision: string;
  attemptId: string;
}
export interface BackendLoginInput {
  username: string;
  password: string;
  authRevision: string;
  attemptId: string;
}
export interface BackendRevisionInput { authRevision: string }
export interface BackendLogout { ok: true; authRevision: string }
export const AUTH_REVISION_HEADER = "X-Auth-Revision";
export const BACKEND_ERROR_CODES = [
  "INVALID_REQUEST", "INVALID_USERNAME", "INVALID_PASSWORD", "INVALID_CREDENTIALS",
  "AUTH_UNAVAILABLE", "SESSION_CONTEXT_REQUIRED", "SESSION_CHANGED", "SESSION_EXPIRED",
  "UNAUTHENTICATED", "FORBIDDEN", "RATE_LIMITED", "SYNC_UNAVAILABLE", "INVALID_OPERATION", "23505",
] as const;
export type BackendErrorCode = (typeof BACKEND_ERROR_CODES)[number];
export interface BackendFailure { ok: false; code: BackendErrorCode }
export function isBackendErrorCode(value: unknown): value is BackendErrorCode {
  return typeof value === "string" && (BACKEND_ERROR_CODES as readonly string[]).includes(value);
}
export const BFF_BOOTSTRAP_LOCK = "ibs-marker-bff-bootstrap";
