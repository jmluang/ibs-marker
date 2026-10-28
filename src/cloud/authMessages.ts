import type { RegistrationErrorCode } from "../domain/authErrors";

export type AuthErrorField = "username" | "password" | "invite";
export function registrationError(code: RegistrationErrorCode): {
  error: string;
  errorField?: AuthErrorField;
} {
  switch (code) {
    case "INVALID_USERNAME": return { error: "请输入有效用户名。", errorField: "username" };
    case "INVALID_PASSWORD": return { error: "密码至少需要 8 个字符，且不能超过 1024 字节。", errorField: "password" };
    case "INVITE_REQUIRED": return { error: "输入邀请码", errorField: "invite" };
    case "INVITE_INVALID": return { error: "邀请码不正确", errorField: "invite" };
    case "USERNAME_TAKEN": return { error: "用户名已存在，请登录。", errorField: "username" };
    case "RATE_LIMITED": return { error: "请求过于频繁，请稍后再试。" };
    case "REGISTRATION_UNAVAILABLE": return { error: "暂时无法注册，请稍后重试。" };
    case "INVALID_REQUEST": return { error: "注册信息无效，请检查后重试。" };
    default: return { error: "注册失败，请重试。" };
  }
}
