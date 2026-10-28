import { describe, expect, it } from "vitest";
import { addDay, dateRangeError, isValidDay } from "../pages/StatsPage";

describe("UI date boundaries", () => {
  it.each([
    "",
    "invalid",
    "2026-02-30",
    "2026-13-01",
    "2026-1-01",
    "2026-10-20T00:00:00Z",
  ])("rejects invalid day %j without throwing", (day) => {
    expect(isValidDay(day)).toBe(false);
    expect(addDay(day, 1)).toBe("");
    expect(dateRangeError(day, "2026-10-20")).not.toBe("");
    expect(dateRangeError("2026-10-20", day)).not.toBe("");
  });
  it.each([
    ["2024-02-28", 1, "2024-02-29"],
    ["2024-02-29", 1, "2024-03-01"],
    ["2026-03-01", -1, "2026-02-28"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2026-01-01", -1, "2025-12-31"],
    ["2026-10-20", 0, "2026-10-20"],
  ] as const)("shifts %s by %i to %s", (day, delta, expected) => {
    expect(addDay(day, delta)).toBe(expected);
    expect(isValidDay(expected)).toBe(true);
  });
  it.each([NaN, Infinity, 0.5, Number.MAX_VALUE])(
    "rejects invalid offset %s",
    (offset) => {
      expect(addDay("2026-10-20", offset)).toBe("");
    },
  );
  it("does not return out-of-format dates at the supported year boundary", () => {
    expect(addDay("9999-12-31", 1)).toBe("");
    expect(addDay("0001-01-01", -1)).toBe("");
    expect(isValidDay("0000-01-01")).toBe(false);
  });
  it("distinguishes missing, invalid and reversed ranges from valid dates", () => {
    expect(dateRangeError("", "2026-10-20")).toContain("请填写");
    expect(dateRangeError("2026-02-30", "2026-10-20")).toContain("有效日期");
    expect(dateRangeError("2026-10-21", "2026-10-20")).toContain("不能晚于");
    expect(dateRangeError("2026-10-20", "2026-10-20")).toBe("");
    expect(dateRangeError("2026-10-01", "2026-10-20")).toBe("");
  });
});
