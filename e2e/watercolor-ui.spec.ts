import { test, expect } from "./bff.fixture";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Entry, ToiletEntry, TrackerSnapshot } from "../src/domain/types";

// Real React + singleton TrackerStore on the explicit development-local fixture.
// Never import this spec into a production-local bypass or use private records.
const note = "合成验收 · 水彩界面 · 非真实健康资料";
const pages = [["今天", "watercolor-home"], ["历史", "watercolor-history"], ["统计", "watercolor-stats"], ["设置", "watercolor-settings"]] as const;
async function store(page: Page, action: "snapshot" | "seed" | "failSave" | "sentinel" | "readSentinel", payload: Entry[] = []): Promise<any> {
  return page.evaluate(async ({ action, payload }) => {
    const path = "/src/state/TrackerStore.ts";
    const { trackerStore: s } = await import(path) as typeof import("../src/state/TrackerStore");
    if (action === "seed") for (const entry of payload) await s.saveEntry(entry);
    if (action === "failSave") {
      const original = s.saveEntry.bind(s);
      s.saveEntry = async (...args) => { s.saveEntry = original; throw Error("SYNTHETIC_SAVE_FAILURE"); };
    }
    const other = "user:33333333-3333-4333-8333-333333333333";
    if (action === "sentinel") await s.adapter.transact(other, data => { data.drafts.watercolorSentinel = "synthetic-other-namespace"; });
    if (action === "readSentinel") return (await s.adapter.read(other)).drafts.watercolorSentinel;
    return s.getSnapshot();
  }, { action, payload });
}
async function open(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("watercolor-home")).toBeVisible();
  expect((await store(page, "snapshot")).namespace).toBe("local");
}
async function nav(page: Page, name: typeof pages[number][0]) {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name, exact: true }).click();
}
async function back(page: Page) { await page.getByRole("button", { name: /返回/ }).first().click(); }
async function openRange(page: Page) {
  await page.getByTestId("stats-range-chip").click();
  const dialog = page.getByRole("dialog", { name: "选择范围", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-testid", "stats-range-dialog");
  return dialog;
}
async function custom(page: Page, from: string, to: string) {
  await openRange(page);
  await page.getByTestId("stats-range-option-custom").click();
  await page.getByTestId("stats-range-from").fill(from);
  await page.getByTestId("stats-range-to").fill(to);
}
function toilet(at: string, overrides: Partial<ToiletEntry> = {}): ToiletEntry {
  return { id: randomUUID(), kind: "toilet", occurredAt: at, createdAt: at, updatedAt: at, estimatedTime: false,
    deletedAt: null, note, result: "passed", stoolForms: [4], discomfort: { status: "none", symptoms: [] },
    startedAt: null, endedAt: null, durationSource: "unknown", estimatedDurationMinutes: null, relief: "unknown", ...overrides };
}
async function day(page: Page) { return page.evaluate(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date())); }
async function chartState(page: Page) {
  return page.getByTestId("stats-time-chart").evaluate(el => ({ text: el.textContent, days: [...el.querySelectorAll('[data-testid="stats-day-row"]')].map(row => row.getAttribute("data-day")) }));
}

for (const width of [320, 390, 1280]) {
  test(`真实四页 ${width}px：计算间距、边界、导航与44px触控`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await open(page);
    const template = `合成布局组合 ${width}px`;
    await nav(page, "设置");
    await page.getByLabel("新组合", { exact: true }).fill(template);
    await page.getByRole("button", { name: "＋ 添加组合", exact: true }).click();
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("设置已保存");
    await expect.poll(async () => (await store(page, "snapshot")).settings.foodTemplates).toEqual([template]);
    await page.reload();
    await expect(page.getByLabel("食物组合1", { exact: true })).toHaveValue(template);
    const measurements: unknown[] = [];
    for (const [name, id] of pages) {
      await nav(page, name);
      const root = page.getByTestId(id);
      await expect(root).toBeVisible();
      const metrics = await root.evaluate(el => {
        const shell = el.closest(".app-shell")!;
        const css = getComputedStyle(shell);
        const navigation = document.querySelector('nav[aria-label="主导航"]')!;
        const rect = navigation.getBoundingClientRect();
        // Measure env() independently: never subtract the shell's own --nav-height.
        const probe = document.createElement("div");
        probe.style.paddingBottom = "env(safe-area-inset-bottom, 0px)";
        shell.append(probe);
        const safeBottom = parseFloat(getComputedStyle(probe).paddingBottom);
        probe.remove();
        return { padding: { top: parseFloat(css.paddingTop), bottomClearance: parseFloat(css.paddingBottom) - rect.height,
            inline: [parseFloat(css.paddingLeft), parseFloat(css.paddingRight)] }, safeBottom,
          noOverflow: document.documentElement.scrollWidth <= innerWidth,
          navigation: { left: rect.left, right: rect.right, bottom: rect.bottom, height: rect.height, paddingBottom: parseFloat(getComputedStyle(navigation).paddingBottom) },
          targets: [...el.querySelectorAll('button, summary, input:not([type="checkbox"]):not([type="hidden"]), select')].filter(node => {
            if ((node as HTMLButtonElement).disabled || node.closest("[hidden]") || node.getClientRects().length === 0) return false;
            const style = getComputedStyle(node);
            // A zero-width layout box is a defect, not a hidden control.
            return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
          }).map(node => ({ label: node.getAttribute("aria-label") || node.textContent, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
          sections: [...el.querySelectorAll(".section, .settings-section")].map(node => {
            const s = getComputedStyle(node);
            return { label: node.className, top: parseFloat(s.paddingTop), bottom: parseFloat(s.paddingBottom),
              firstReminder: node.classList.contains("settings-reminders"), settings: node.classList.contains("settings-section") };
          }) };
      });
      measurements.push({ name, width, ...metrics });
      expect(metrics.noOverflow).toBe(true);
      // 12–16px is the compact block spacing, not the 18px/28px inline gutter.
      for (const value of [metrics.padding.top, metrics.padding.bottomClearance]) {
        if (width < 600) { expect(value).toBeGreaterThanOrEqual(12); expect(value).toBeLessThanOrEqual(16); }
        else expect(value).toBe(16); // Existing desktop shell design, independently of mobile caps.
      }
      for (const value of metrics.padding.inline) expect(value).toBe(width < 600 ? 18 : 28);
      // Bound the actual occluder too, so an inflated nav variable cannot hide whitespace.
      expect(metrics.navigation.height - metrics.safeBottom).toBeCloseTo(64, 1);
      for (const section of metrics.sections) {
        if (section.firstReminder) expect(section.top, section.label).toBe(0); // First group has no divider inset.
        else { expect(section.top, section.label).toBeGreaterThanOrEqual(12); expect(section.top, section.label).toBeLessThanOrEqual(16); }
        // Settings groups have two-sided padding; legacy divider/chart sections only a top inset.
        if (section.settings) { expect(section.bottom, section.label).toBeGreaterThanOrEqual(12); expect(section.bottom, section.label).toBeLessThanOrEqual(16); }
        else expect(section.bottom, section.label).toBe(0);
      }
      for (const target of metrics.targets) {
        expect.soft(target.width, String(target.label)).toBeGreaterThan(0);
        expect.soft(target.height, String(target.label)).toBeGreaterThanOrEqual(44);
      }
      if (name === "设置") {
        const combination = page.getByLabel("食物组合1", { exact: true });
        await expect(combination).toBeVisible();
        expect((await combination.boundingBox())!.width).toBeGreaterThan(80);
        for (const value of [`${template} · 已编辑`, template]) {
          await combination.click();
          await combination.fill(value);
          await page.getByRole("button", { name: "保存设置", exact: true }).click();
          await expect(page.getByRole("status")).toHaveText("设置已保存");
          await expect.poll(async () => (await store(page, "snapshot")).settings.foodTemplates).toEqual([value]);
          await page.reload();
          await expect(combination).toBeVisible();
          await expect(combination).toHaveValue(value);
          expect((await combination.boundingBox())!.width).toBeGreaterThan(80);
          expect((await store(page, "snapshot")).settings.foodTemplates).toEqual([value]);
        }
      }
      expect(metrics.navigation.left).toBeGreaterThanOrEqual(0);
      expect(metrics.navigation.right).toBeLessThanOrEqual(width);
      expect(metrics.navigation.bottom).toBeLessThanOrEqual(850);
      expect(metrics.navigation.paddingBottom).toBeGreaterThanOrEqual(0);
      for (const button of await page.getByRole("navigation").getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: info.outputPath(`${id}-${width}.png`), fullPage: true });
    }
    await nav(page, "今天");
    // A manual record belongs to the record area, not the primary timer card.
    const manual = page.getByRole("button", { name: /^补记(?:一次|如厕)/ });
    const timer = page.getByRole("button", { name: /开始如厕|开始计时/ });
    expect(await manual.evaluate((el, timerEl) => !el.parentElement!.contains(timerEl as Node), await timer.elementHandle())).toBe(true);
    await manual.click();
    await expect(page.getByRole("navigation")).toHaveCount(0);
    const formCss = await page.locator(".app-shell").evaluate(el => {
      const probe = document.createElement("div");
      probe.style.paddingBottom = "env(safe-area-inset-bottom, 0px)";
      el.append(probe);
      const safeBottom = parseFloat(getComputedStyle(probe).paddingBottom);
      probe.remove();
      const css = getComputedStyle(el);
      return { top: parseFloat(css.paddingTop), bottom: parseFloat(css.paddingBottom) - safeBottom,
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(formCss.top).toBeGreaterThanOrEqual(12); expect(formCss.top).toBeLessThanOrEqual(16);
    expect(formCss.bottom).toBeGreaterThanOrEqual(12); expect(formCss.bottom).toBeLessThanOrEqual(16);
    expect(formCss.overflow).toBe(false);
    await info.attach("computed-layout", { body: JSON.stringify({ measurements, formCss }, null, 2), contentType: "application/json" });
  });
}

test("补记真实保存、草稿/编辑/历史筛选与unknown不变none", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: /^补记(?:一次|如厕)/ }).click();
  for (const label of ["有排出吗？", "有不适或困难吗？", "排后有缓解吗？"]) {
    await expect(page.getByRole("group", { name: label, exact: true }).getByRole("button", { name: "不确定", exact: true })).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByLabel("备注（可选）").fill(note);
  await expect(page.getByRole("status")).toContainText("草稿已保存在本机");
  await page.reload();
  await expect(page.getByLabel("备注（可选）")).toHaveValue(note);
  await page.getByRole("button", { name: "保存如厕记录", exact: true }).click();
  let snapshot = await store(page, "snapshot") as TrackerSnapshot;
  expect(snapshot.entries).toHaveLength(1);
  expect(snapshot.entries[0]).toMatchObject({ note, result: "unsure", discomfort: { status: "unknown" }, relief: "unknown", estimatedDurationMinutes: null });
  expect(snapshot.timer).toBeNull();
  await nav(page, "历史");
  await page.getByLabel("历史日期").fill(await day(page));
  await page.getByRole("group", { name: "记录类型", exact: true }).getByRole("button", { name: "症状", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(0);
  await page.getByRole("group", { name: "记录类型", exact: true }).getByRole("button", { name: "如厕", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(1);
  await page.locator(".entry").click();
  await page.getByLabel("备注（可选）").fill(note + " · 已编辑");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  snapshot = await store(page, "snapshot");
  expect(snapshot.entries[0].note).toBe(note + " · 已编辑");
  expect(snapshot.editRevisions[snapshot.entries[0].id]).toBe(2);
  await nav(page, "历史");
  await page.getByLabel("历史日期").fill("");
  await expect(page.locator(".entry")).toHaveCount(0);
  await page.getByRole("button", { name: "前一天", exact: true }).click();
  await expect(page.getByLabel("历史日期")).not.toHaveValue("");
});

for (const ended of [false, true]) {
  test(`补记取消/失败/成功不改${ended ? "已结束" : "活动"}计时，跨四页/模态/刷新持久`, async ({ page }) => {
    await open(page);
    await page.clock.install();
    await page.getByRole("button", { name: /开始如厕|开始计时/ }).click();
    if (ended) await page.getByRole("button", { name: "结束如厕", exact: true }).click();
    await back(page);
    const timer = (await store(page, "snapshot")).timer;
    expect(timer).not.toBeNull();
    for (const [name] of pages) { await nav(page, name); expect((await store(page, "snapshot")).timer).toEqual(timer); }
    await nav(page, "统计");
    await openRange(page);
    await page.keyboard.press("Escape");
    await nav(page, "今天");
    await page.getByRole("button", { name: /^补记(?:一次|如厕)/ }).click();
    await back(page);
    expect((await store(page, "snapshot")).timer).toEqual(timer);
    await page.getByRole("button", { name: /^补记(?:一次|如厕)/ }).click();
    await page.getByLabel("备注（可选）").fill(note);
    await expect(page.getByRole("status")).toContainText("草稿已保存在本机");
    await store(page, "failSave");
    await page.getByRole("button", { name: "保存如厕记录", exact: true }).click();
    await expect(page.getByRole("alert").first()).toBeVisible();
    expect((await store(page, "snapshot")).timer).toEqual(timer);
    await page.getByRole("button", { name: "保存如厕记录", exact: true }).click();
    expect((await store(page, "snapshot")).timer).toEqual(timer);
    expect((await store(page, "snapshot")).entries[0].id).not.toBe(timer.id);
    await page.reload();
    await expect(page.getByTestId("watercolor-home")).toBeVisible();
    expect((await store(page, "snapshot")).timer).toEqual(timer);
    await page.evaluate(() => { location.hash = "timer"; });
    await expect(page.locator(".stopwatch")).toBeVisible();
    const elapsed = await page.locator(".stopwatch").textContent();
    await page.clock.runFor(2_100);
    if (ended) await expect(page.locator(".stopwatch")).toHaveText(elapsed!);
    else await expect(page.locator(".stopwatch")).not.toHaveText(elapsed!);
    expect((await store(page, "snapshot")).timer).toEqual(timer);
  });
}

test("范围仅portal确认生效；取消/X/背景/Escape保留图、焦点锁与inert恢复", async ({ page }) => {
  await open(page); await nav(page, "统计");
  await expect(page.getByTestId("stats-range-option-7")).toHaveCount(0);
  const before = await chartState(page);
  const chipBefore = await page.getByTestId("stats-range-chip").textContent();
  await expect(page.getByTestId("stats-day-row")).toHaveCount(7);
  await expect(page.getByTestId("stats-range-chip")).toContainText("7天");
  for (const dismiss of ["cancel", "close", "escape", "backdrop"] as const) {
    const dialog = await openRange(page);
    expect(await dialog.evaluate(el => !document.querySelector("#root")!.contains(el))).toBe(true);
    const modalCss = await dialog.evaluate(el => { const s = getComputedStyle(el); return { left: parseFloat(s.paddingLeft), right: parseFloat(s.paddingRight) }; });
    for (const padding of Object.values(modalCss)) { expect(padding).toBeGreaterThanOrEqual(14); expect(padding).toBeLessThanOrEqual(16); }
    expect(await page.getByRole("navigation", { includeHidden: true }).evaluate(el => !!el.closest("[inert]"))).toBe(true);
    expect(await dialog.evaluate(el => !el.closest("[inert]"))).toBe(true);
    await page.getByTestId("stats-range-option-30").click();
    expect(await chartState(page)).toEqual(before);
    for (const direction of ["Tab", "Shift+Tab"]) for (let i = 0; i < 16; i++) { await page.keyboard.press(direction); expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true); }
    if (dismiss === "escape") await page.keyboard.press("Escape");
    else if (dismiss === "backdrop") {
      const box = (await dialog.boundingBox())!;
      await page.mouse.click(Math.max(1, box.x - 3), Math.max(1, box.y - 3));
    } else await page.getByTestId(`stats-range-${dismiss}`).click();
    await expect(dialog).toHaveCount(0);
    expect(await chartState(page)).toEqual(before);
    await expect(page.getByTestId("stats-day-row")).toHaveCount(7);
    await expect(page.getByTestId("stats-range-chip")).toHaveText(chipBefore!);
    await expect(page.getByTestId("stats-range-chip")).toBeFocused();
    expect(await page.getByRole("navigation").evaluate(el => !el.closest("[inert]"))).toBe(true);
  }
  // Preserve an existing inert attribute value, rather than remove all inert state.
  await page.locator("#root").evaluate(el => el.setAttribute("inert", ""));
  await page.getByTestId("stats-range-chip").evaluate(el => (el as HTMLButtonElement).click());
  await expect(page.getByTestId("stats-range-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await page.locator("#root").evaluate(el => el.removeAttribute("inert"));
  await openRange(page); await page.getByTestId("stats-range-option-30").click();
  await page.getByTestId("stats-range-confirm").click();
  await expect(page.getByTestId("stats-day-row")).toHaveCount(30);
  await expect(page.getByTestId("stats-range-chip")).toContainText("30天");
  const applied30 = await chartState(page);
  const chip30 = await page.getByTestId("stats-range-chip").textContent();
  for (const dismiss of ["cancel", "close", "backdrop", "escape"] as const) {
    const dialog = await openRange(page);
    expect(await page.getByRole("navigation", { includeHidden: true }).evaluate(el => !!el.closest("[inert]"))).toBe(true);
    expect(await dialog.evaluate(el => !el.closest("[inert]"))).toBe(true);
    await page.getByTestId("stats-range-option-7").click();
    expect(await chartState(page)).toEqual(applied30);
    await expect(page.getByTestId("stats-day-row")).toHaveCount(30);
    await expect(page.getByTestId("stats-range-chip")).toHaveText(chip30!);
    for (const direction of ["Tab", "Shift+Tab"]) for (let i = 0; i < 16; i++) { await page.keyboard.press(direction); expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true); }
    if (dismiss === "escape") await page.keyboard.press("Escape");
    else if (dismiss === "backdrop") {
      const box = (await dialog.boundingBox())!;
      await page.mouse.click(Math.max(1, box.x - 3), Math.max(1, box.y - 3));
    } else await page.getByTestId(`stats-range-${dismiss}`).click();
    await expect(dialog).toHaveCount(0);
    expect(await chartState(page)).toEqual(applied30);
    await expect(page.getByTestId("stats-day-row")).toHaveCount(30);
    await expect(page.getByTestId("stats-range-chip")).toHaveText(chip30!);
    await expect(page.getByTestId("stats-range-chip")).toBeFocused();
    expect(await page.getByRole("navigation").evaluate(el => !el.closest("[inert]"))).toBe(true);
  }
  await openRange(page); await page.getByTestId("stats-range-option-7").click();
  await page.getByTestId("stats-range-confirm").click();
  await expect(page.getByTestId("stats-range-dialog")).toHaveCount(0);
  await expect(page.getByTestId("stats-day-row")).toHaveCount(7);
  await expect(page.getByTestId("stats-range-chip")).toContainText("7天");
  await expect(page.getByTestId("stats-range-chip")).toBeFocused();
  expect(await page.getByRole("navigation").evaluate(el => !el.closest("[inert]"))).toBe(true);
});

test("原生日期clear/倒序/366含首尾/367拒绝/闰日不崩溃", async ({ page }) => {
  await open(page); await nav(page, "统计");
  const before = await chartState(page);
  const current = await day(page);
  await custom(page, current, current);
  for (const id of ["stats-range-from", "stats-range-to"]) {
    await page.getByTestId(id).fill("");
    await expect(page.getByTestId("stats-range-dialog").getByRole("alert")).toBeVisible();
    expect(await chartState(page)).toEqual(before);
    await page.getByTestId(id).fill(current);
  }
  await page.getByTestId("stats-range-from").fill("2024-03-02");
  await page.getByTestId("stats-range-to").fill("2024-03-01");
  await expect(page.getByTestId("stats-range-dialog").getByRole("alert")).toContainText("开始日期不能晚于结束日期");
  await page.getByTestId("stats-range-from").fill("2024-01-01");
  await page.getByTestId("stats-range-to").fill("2024-12-31");
  await page.getByTestId("stats-range-confirm").click();
  await expect(page.getByTestId("stats-day-row")).toHaveCount(366);
  await expect(page.locator('[data-testid="stats-day-row"][data-day="2024-01-01"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="stats-day-row"][data-day="2024-12-31"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="stats-day-row"][data-day="2024-02-29"]')).toHaveCount(1);
  await custom(page, "2024-01-01", "2025-01-01");
  await expect(page.getByTestId("stats-range-dialog").getByRole("alert")).toContainText("366");
  await page.getByTestId("stats-range-cancel").click();
  await expect(page.getByTestId("stats-day-row")).toHaveCount(366);
});

test("真实领域fixture：上海跨UTC/多形态/未知/零/删除排除/近点lane与点日期编辑", async ({ page }, info) => {
  await open(page);
  const d = await day(page);
  const at = (time: string) => new Date(`${d}T${time}+08:00`).toISOString();
  const entries = [
    toilet(at("00:01:00"), { stoolForms: [2, 6, "unknown"], estimatedTime: true }),
    toilet(at("00:01:10"), { result: "none", stoolForms: [], durationSource: "estimated", estimatedDurationMinutes: 0 }),
    toilet(at("00:01:20"), { result: "unsure", stoolForms: [], discomfort: { status: "unknown", symptoms: [] } }),
    toilet(at("00:01:30"), { stoolForms: [4], durationSource: "estimated", estimatedDurationMinutes: 8 }),
    toilet(at("23:59:00"), { deletedAt: new Date().toISOString(), note: "合成已删除不得显示" }),
  ];
  await store(page, "seed", entries);
  await nav(page, "统计");
  await custom(page, d, d); await page.getByTestId("stats-range-confirm").click();
  const row = page.locator(`[data-testid="stats-day-row"][data-day="${d}"]`);
  await expect(row.getByTestId("stats-time-event")).toHaveCount(4);
  await expect(page.locator(`[data-entry-id="${entries[4].id}"]`)).toHaveCount(0);
  const boxes = [];
  for (const entry of entries.slice(0, 4)) {
    const glyph = row.locator(`[data-testid="stats-time-event"][data-entry-id="${entry.id}"]`);
    await expect(glyph).toBeVisible();
    boxes.push((await glyph.boundingBox())!);
  }
  // Every close event has a distinct lane; its painted box must fit its own day.
  const bounds = (await row.boundingBox())!;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]; expect(b.y).toBeGreaterThanOrEqual(bounds.y); expect(b.y + b.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
    for (let j = i + 1; j < boxes.length; j++) { const c = boxes[j]; expect(b.x + b.width <= c.x || c.x + c.width <= b.x || b.y + b.height <= c.y || c.y + c.height <= b.y).toBe(true); }
  }
  for (const form of [2, 4, 6]) {
    const shape = page.locator(`[data-testid="stats-shape-row"][data-form="${form}"]`);
    await expect(shape).toContainText("1");
    const painted = await shape.locator("em").evaluate(el => ({ width: el.getBoundingClientRect().width, track: el.parentElement!.getBoundingClientRect().width, height: el.getBoundingClientRect().height, background: getComputedStyle(el).backgroundImage }));
    expect(painted.width).toBeGreaterThan(0); expect(painted.height).toBeGreaterThan(0);
    expect(painted.width / painted.track).toBeCloseTo(1 / 3, 1);
    expect(painted.background).not.toBe("none");
  }
  await expect(page.getByTestId("watercolor-stats").locator(".stats-compact-row").filter({ hasText: "平均用时" })).toContainText("4.0 分钟");
  const firstGlyph = row.locator(`[data-entry-id="${entries[0].id}"]`);
  await expect(firstGlyph).toHaveAttribute("data-minute", "1");
  await expect(firstGlyph).toHaveAttribute("data-result", "passed");
  await expect(firstGlyph).toContainText("~");
  await expect(row.locator(`[data-entry-id="${entries[1].id}"]`)).toHaveAttribute("data-result", "none");
  await expect(row.locator(`[data-entry-id="${entries[2].id}"]`)).toHaveAttribute("data-result", "unsure");
  await expect(row.locator(`[data-entry-id="${entries[3].id}"]`)).not.toContainText("~");
  await expect(page.getByTestId("watercolor-stats")).toContainText(/未知|没看清/);
  await expect(page.getByTestId("watercolor-stats")).toContainText(/时长已知\s*2/);
  await expect(page.getByTestId("watercolor-stats")).toContainText(/缺失\s*2/);
  await info.attach("synthetic-domain-and-painted-lanes", { body: JSON.stringify({ entries, boxes, bounds }, null, 2), contentType: "application/json" });
  await row.click();
  await expect(page.locator(".entry")).toHaveCount(4);
  await page.locator(".entry").first().click();
  await page.getByLabel("备注（可选）").fill(note + " · 从统计编辑");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  expect((await store(page, "snapshot")).entries.some((entry: Entry) => entry.note === note + " · 从统计编辑")).toBe(true);
});

test("设置草稿显式保存/CAS/组合添删改与真实导出取消和namespace清理", async ({ page, context }) => {
  await open(page);
  const d = await day(page);
  await store(page, "seed", [toilet(new Date(`${d}T01:00:00+08:00`).toISOString())]);
  await store(page, "sentinel");
  await nav(page, "设置");
  const initial = (await store(page, "snapshot")).settings;
  await test.step("组合添改、精确草稿落盘与刷新恢复（零宽输入必须失败）", async () => {
    await page.getByLabel("早餐提醒时间", { exact: true }).fill("09:15");
    await page.getByLabel("新组合", { exact: true }).fill("合成组合A");
    await page.getByRole("button", { name: "＋ 添加组合", exact: true }).click();
    const combination = page.getByLabel("食物组合1", { exact: true });
    // Trace RED: this real input has width 0; do not force-fill or bypass CSS.
    await expect(combination).toBeVisible();
    await combination.fill("合成组合B");
    // A status from the previous queued draft is not proof that B is durable.
    await expect.poll(() => page.evaluate(async () => {
      const path = "/src/state/TrackerStore.ts";
      const { trackerStore: s } = await import(path) as typeof import("../src/state/TrackerStore");
      return (await s.adapter.read(s.getSnapshot().namespace!)).drafts["settings:editor"];
    })).toMatchObject({ settings: { foodTemplates: ["合成组合B"], meals: { breakfast: { time: "09:15" } } }, template: "" });
    await expect(page.getByRole("status")).toContainText("草稿已保存在本机");
    expect((await store(page, "snapshot")).settings).toEqual(initial);
    await page.reload();
    await expect(page.getByLabel("食物组合1", { exact: true })).toHaveValue("合成组合B");
    await expect(page.getByLabel("早餐提醒时间", { exact: true })).toHaveValue("09:15");
  });
  await test.step("先制造dirty旧编辑器，再保存另一页并验证CAS拒绝覆盖", async () => {
    const second = await context.newPage(); await second.goto("/#settings");
    await expect(second.getByTestId("watercolor-settings")).toBeVisible();
    await second.getByLabel("早餐提醒时间", { exact: true }).fill("10:30");
    await expect(second.getByLabel("早餐提醒时间", { exact: true })).toHaveValue("10:30");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("设置已保存");
    const committed = (await store(page, "snapshot")).settings;
    expect(committed).toMatchObject({ foodTemplates: ["合成组合B"], meals: { breakfast: { time: "09:15" } } });
    await second.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(second.getByRole("alert").first()).toContainText("另一标签页");
    await expect.poll(async () => (await store(second, "snapshot")).settings).toEqual(committed);
    await second.close();
  });
  await test.step("删除组合后显式保存", async () => {
    await page.getByRole("button", { name: "删除食物组合1", exact: true }).click();
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("设置已保存");
    expect((await store(page, "snapshot")).settings.foodTemplates).toEqual([]);
  });
  await test.step("原生确认取消、真实下载与当前namespace清理不触及sentinel", async () => {
  const downloads: string[] = [];
  page.on("download", download => downloads.push(download.suggestedFilename()));
  page.once("dialog", async dialog => { expect(dialog.message()).toContain("敏感"); await dialog.dismiss(); });
  await page.getByRole("button", { name: "下载 JSON", exact: true }).click();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(downloads).toEqual([]);
  page.once("dialog", async dialog => { expect(dialog.message()).toContain("敏感"); await dialog.accept(); });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 JSON", exact: true }).click();
  const download = await downloadPromise;
  const exported = await readFile((await download.path())!, "utf8");
  expect(exported).toContain(note);
  expect(exported).toContain("passed");
  page.once("dialog", async dialog => { expect(dialog.message()).toContain("不会删除云端"); await dialog.dismiss(); });
  await page.getByRole("button", { name: "清理此身份的本机数据", exact: true }).click();
  expect((await store(page, "snapshot")).entries).toHaveLength(1);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "清理此身份的本机数据", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("本机数据已清理");
  const cleared = await store(page, "snapshot");
  expect(cleared.entries).toEqual([]); expect(cleared.timer).toBeNull(); expect(cleared.outbox).toEqual([]);
  expect(await store(page, "readSentinel")).toBe("synthetic-other-namespace");
  });
});

test("前台提醒只spy本页触发；字体真实加载与许可可折叠", async ({ page }) => {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    Object.defineProperty(window, "__watercolorNotifications", { value: calls });
    class SyntheticNotification {
      static permission = "granted";
      static requestPermission = async () => { calls.push({ permissionRequest: true }); return "granted"; };
      constructor(title: string, options: unknown) { calls.push({ title, options }); }
    }
    Object.defineProperty(window, "Notification", { value: SyntheticNotification, configurable: true });
  });
  await open(page); await nav(page, "设置");
  await expect(page.getByTestId("watercolor-settings")).toContainText("仅页面运行时");
  for (const meal of ["早餐", "午餐", "晚餐"]) await page.getByLabel(`${meal}提醒时间`, { exact: true }).fill("00:00");
  await page.getByLabel("开启前台记录提醒", { exact: true }).check();
  expect((await store(page, "snapshot")).settings.remindersEnabled).toBe(false);
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("设置已保存");
  await expect.poll(() => page.evaluate(() => (window as any).__watercolorNotifications.length)).toBeGreaterThan(0);
  const calls = await page.evaluate(() => (window as any).__watercolorNotifications);
  for (const call of calls) { expect(call.title).toBe("有一条记录提醒"); expect(call.options.body).not.toMatch(/如厕|排便|健康|疾病/); }
  const font = await page.evaluate(async () => { await document.fonts.load('16px "Xiaolai UI"'); await document.fonts.ready; return { loaded: [...document.fonts].some(face => face.family.replaceAll('"', "") === "Xiaolai UI" && face.status === "loaded"), heading: getComputedStyle(document.querySelector("h1")!).fontFamily }; });
  expect(font.loaded).toBe(true); expect(font.heading).toContain("Xiaolai UI");
  const disclosure = page.locator("details").filter({ hasText: /字体|许可/ });
  await expect(disclosure).toHaveCount(1);
  await disclosure.locator("summary").click();
  await expect(disclosure).toContainText(/SIL|OFL/);
  await disclosure.locator("summary").click();
  expect(await disclosure.evaluate(el => (el as HTMLDetailsElement).open)).toBe(false);
});
