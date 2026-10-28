import { describe, it, expect } from "vitest";
import { newEntry } from "../components/EntryForm";
import { entryTitle, errorText } from "../components/ui";
import { validateEntry } from "../domain/helpers";
describe("UI record defaults preserve unknown data", () => {
  it("creates valid unseeded defaults with fresh UUIDs", () => {
    for (const kind of ["toilet", "meal", "symptom"] as const) {
      const a = newEntry(kind);
      const b = newEntry(kind);
      expect(a.id).not.toBe(b.id);
      expect(validateEntry(a)).toEqual([]);
      expect(a.note).toBe("");
      expect(a.deletedAt).toBeNull();
    }
  });
  it("does not turn unknown duration or symptoms into zero/none", () => {
    const e = newEntry("toilet");
    expect(e.kind).toBe("toilet");
    if (e.kind === "toilet") {
      expect(e.durationSource).toBe("unknown");
      expect(e.estimatedDurationMinutes).toBeNull();
      expect(e.discomfort.status).toBe("unknown");
      expect(e.stoolForms).toEqual([]);
      expect(entryTitle(e)).toBe("排便结果不确定");
    }
  });
  it("explains resource conflicts and meal uniqueness without claiming success", () => {
    expect(errorText(Error("STALE_REVISION"))).toContain("另一标签页");
    expect(errorText(Error("MEAL_SLOT_EXISTS"))).toContain("已有记录");
    expect(errorText(Error("IDB_BLOCKED"))).toContain("未能保存");
  });
});
