export const registrationErrorCodes = [
  "INVALID_REQUEST",
  "INVALID_USERNAME",
  "INVALID_PASSWORD",
  "INVITE_REQUIRED",
  "INVITE_INVALID",
  "USERNAME_TAKEN",
  "RATE_LIMITED",
  "REGISTRATION_UNAVAILABLE",
  "REGISTRATION_FAILED",
] as const;

export type RegistrationErrorCode = (typeof registrationErrorCodes)[number];

export function isRegistrationErrorCode(value: unknown): value is RegistrationErrorCode {
  return typeof value === "string" && (registrationErrorCodes as readonly string[]).includes(value);
}

export interface RegistrationResult {
  registered: boolean;
}
