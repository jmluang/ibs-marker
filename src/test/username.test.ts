import { describe, it, expect } from "vitest";
import { isValidUsername, usernameToInternalEmail } from "../domain/username";
describe("frozen username contract", () => {
  it.each(["Alice", "alice", "名字", "😀", "a b", "é", "é"])("preserves original UTF8: %s", (name) => {
    expect(isValidUsername(name)).toBe(true);
    expect(usernameToInternalEmail(name)).toBe(`u-${Buffer.from(name).toString("hex")}@ibs-marker.invalid`);
  });
  it("is case sensitive and does not normalize", () => {
    expect(usernameToInternalEmail("Alice")).not.toBe(usernameToInternalEmail("alice"));
    expect(usernameToInternalEmail("é")).not.toBe(usernameToInternalEmail("é"));
  });
  it.each([null, 1, "", " a", "a ", "\u00a0a", "a\n", "a\u0000b", "a\u007fb", "a\u0085b", "\ud800", "\udc00", "a\ud800b", "字".repeat(11), "a".repeat(31), "😀".repeat(8)])("rejects invalid input %j", (name) => {
    expect(isValidUsername(name)).toBe(false);
    expect(() => usernameToInternalEmail(name as string)).toThrow();
  });
  it("uses a byte limit, inclusive at thirty", () => {
    expect(isValidUsername("字".repeat(10))).toBe(true);
    expect(isValidUsername("😀".repeat(7) + "ab")).toBe(true);
  });
});
