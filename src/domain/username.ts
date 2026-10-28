/** Frozen identity contract: preserve case and original Unicode bytes. */
export function isValidUsername(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.trim() !== value) return false;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  // Reject unpaired surrogates before TextEncoder could replace them with U+FFFD.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return new TextEncoder().encode(value).length <= 30;
}
export function usernameToInternalEmail(username: string): string {
  if (!isValidUsername(username)) throw new Error("Invalid username");
  const hex = Array.from(new TextEncoder().encode(username), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `u-${hex}@ibs-marker.invalid`;
}
