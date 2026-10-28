import { test, expect } from "./bff.fixture";
import { writeFile } from "node:fs/promises";

test("compact UI：补记按钮实际边距、居中与表单短文案", async ({ page }, testInfo) => {
  await open(page);
  const measurements = [];
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    const button = page.getByRole("button", { name: "补记如厕 ＋", exact: true });
    const css = await button.evaluate(el => {
      const s = getComputedStyle(el);
      const bounds = el.getBoundingClientRect();
      const timer = document.querySelector(".last-card")!.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(el);
      const textBounds = text.getBoundingClientRect();
      return { paddingLeft: s.paddingLeft, paddingRight: s.paddingRight,
        paddingTop: s.paddingTop, textAlign: s.textAlign, height: bounds.height, hitWidth: bounds.width,
        textCenterOffset: Math.abs((textBounds.left + textBounds.right - bounds.left - bounds.right) / 2),
        leftInset: bounds.left, rightInset: innerWidth - bounds.right,
        outsideTimer: !el.closest(".last-card"), belowTimer: bounds.top >= timer.bottom,
        noOverflow: document.documentElement.scrollWidth <= innerWidth };
    });
    measurements.push({ width, ...css });
    await page.screenshot({ path: testInfo.outputPath(`home-${width}.png`), fullPage: true });
    // Approved v5 puts this action beside the timeline heading, not inside the timer card.
    // Keep the original touch/alignment/edge regression without freezing the old card padding.
    expect.soft(css.leftInset).toBeGreaterThanOrEqual(12);
    expect.soft(css.rightInset).toBeGreaterThanOrEqual(12);
    expect.soft(css.textCenterOffset).toBeLessThanOrEqual(1);
    expect.soft(css.height).toBeGreaterThanOrEqual(44);
    expect.soft(css.hitWidth).toBeGreaterThanOrEqual(44);
    expect.soft(css.outsideTimer).toBe(true);
    expect.soft(css.belowTimer).toBe(true);
    expect.soft(css.noOverflow).toBe(true);
    await button.click();
    await page.screenshot({ path: testInfo.outputPath(`form-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "返回", exact: false }).click();
  }
  await writeFile(testInfo.outputPath("computed-css.json"), JSON.stringify(measurements, null, 2));
  await page.getByRole("button", { name: "补记如厕 ＋", exact: true }).click();
  for (const name of ["有排出吗？", "有不适或困难吗？", "排后有缓解吗？"]) {
    const group = page.getByRole("group", { name, exact: true });
    await expect(group.getByRole("button")).toHaveText(name === "排后有缓解吗？" ? ["有", "部分", "无", "不确定"] : ["有", "无", "不确定"]);
    await expect(group.getByRole("button", { name: "不确定", exact: true })).toHaveAttribute("aria-pressed", "true");
  }
});

test("compact UI：分组有无、草稿刷新与未知保存不变零", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "补记如厕 ＋", exact: true }).click();
  const result = page.getByRole("group", { name: "有排出吗？", exact: true });
  const discomfort = page.getByRole("group", { name: "有不适或困难吗？", exact: true });
  const relief = page.getByRole("group", { name: "排后有缓解吗？", exact: true });
  await result.getByRole("button", { name: "有", exact: true }).click();
  await page.getByRole("button", { name: "4 光滑", exact: true }).click();
  await discomfort.getByRole("button", { name: "有", exact: true }).click();
  await relief.getByRole("button", { name: "有", exact: true }).click();
  await expect(page.getByLabel("腹痛程度")).toBeVisible();
  for (const group of [result, discomfort, relief]) await group.getByRole("button", { name: "无", exact: true }).click();
  await expect(page.getByLabel("腹痛程度")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("草稿已保存在本机");
  await page.reload();
  for (const group of [result, discomfort, relief]) await expect(group.getByRole("button", { name: "无", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "保存如厕记录", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(1);
  await page.getByRole("button", { name: "补记如厕 ＋", exact: true }).click();
  await page.getByRole("button", { name: "保存如厕记录", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(2);
  const values = await page.evaluate(async () => {
    const { trackerStore } = await import(String("/src/state/TrackerStore.ts"));
    return trackerStore.getSnapshot().entries.map((e: any) => ({ result: e.result, discomfort: e.discomfort.status, relief: e.relief, duration: e.estimatedDurationMinutes }));
  });
  expect(values).toEqual(expect.arrayContaining([
    { result: "none", discomfort: "none", relief: "no", duration: null },
    { result: "unsure", discomfort: "unknown", relief: "unknown", duration: null },
  ]));
  await expect(page.locator(".entry").filter({ hasText: "排便结果不确定" })).toHaveCount(1);
});
const fixtures = {
  food: "合成测试 · 米饭与蔬菜",
  note: "合成测试 · 不是真实健康资料",
};
async function open(page: any) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "肠记", exact: true }),
  ).toBeVisible();
}
test("真实三类记录、草稿刷新、编辑删除、筛选、统计与下载", async ({ page }) => {
  await open(page);
  await expect(page.locator(".empty")).toBeVisible();
  await page.getByRole("button", { name: "补记如厕 ＋" }).click();
  await page.getByRole("group", { name: "有排出吗？", exact: true }).getByRole("button", { name: "有", exact: true }).click();
  await page.getByRole("button", { name: "4 光滑", exact: true }).click();
  await page.getByRole("group", { name: "有不适或困难吗？", exact: true }).getByRole("button", { name: "无", exact: true }).click();
  await page.getByLabel("备注（可选）").fill(fixtures.note);
  await expect(page.getByRole("status")).toContainText("草稿已保存在本机");
  await page.reload();
  await expect(page.getByLabel("备注（可选）")).toHaveValue(fixtures.note);
  await page.getByRole("button", { name: "保存如厕记录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "今天记录", exact: true })).toBeVisible();
  await expect(page.locator(".entry")).toHaveCount(1);
  await page.getByText("其他记录 ＋").click();
  await page.locator(".add-menu").getByRole("button", { name: /^记(?:录)?独立症状$/ }).click();
  await page.getByRole("group", { name: "有不适或困难吗？", exact: true }).getByRole("button", { name: "有", exact: true }).click();
  await page.getByLabel("腹痛程度").selectOption("mild");
  await page.getByLabel("当时的情境").fill("合成测试 · 饭后");
  await page.getByRole("button", { name: "保存症状记录", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(2);
  await page.getByText("其他记录 ＋").click();
  await page.getByRole("button", { name: "记录加餐 / 饮料" }).click();
  await page.getByLabel("吃了什么、喝了什么？").fill(fixtures.food);
  await page.getByRole("button", { name: "奶", exact: true }).click();
  await page.getByRole("button", { name: "保存饮食记录", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(3);
  await page.getByRole("button", { name: "历史", exact: true }).click();
  await page.getByRole("button", { name: "症状", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(1);
  await page.locator(".entry").click();
  await page.getByLabel("当时的情境").fill("合成测试 · 修改");
  await page.getByRole("button", { name: "保存修改" }).click();
  await page.getByRole("button", { name: "统计", exact: true }).click();
  await expect(page.getByRole("heading", { name: "如厕时点", exact: true })).toBeVisible();
  await expect(page.getByTestId("stats-time-event")).toHaveCount(1);
  await expect(page.getByTestId("stats-time-event")).toHaveAttribute("data-result", "passed");
  await expect(page.locator(".stats-compact-row").filter({ hasText: "不适报告 / 状态已知" })).toContainText("1 / 2 条");
  await page.locator("summary").filter({ hasText: "数据说明 · 已知与未知" }).click();
  await expect(page.locator(".stats-completeness")).toHaveCount(7);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("新组合").fill("合成测试 · 牛奶与面包");
  await page.getByRole("button", { name: "＋ 添加组合" }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("设置已保存");
  await page.reload();
  await expect(page.getByLabel("食物组合1", { exact: true })).toHaveValue(
    "合成测试 · 牛奶与面包",
  );
  page.on("dialog", (d) => d.accept());
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 CSV" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await page.locator(".entry").filter({ hasText: fixtures.food }).click();
  await page.getByRole("button", { name: "删除记录", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(2);
});
test("计时跨刷新、结束后草稿恢复且不再走秒", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "开始如厕 ↗" }).click();
  await expect(
    page.getByRole("button", { name: "结束如厕", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "结束如厕", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "结束如厕", exact: true }).click();
  await expect(page.getByText("填写如厕记录")).toBeVisible();
  await page.getByRole("group", { name: "有排出吗？", exact: true }).getByRole("button", { name: "无", exact: true }).click();
  await page.getByRole("group", { name: "有不适或困难吗？", exact: true }).getByRole("button", { name: "无", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("草稿已保存在本机");
  await page.reload();
  await expect(
    page.getByRole("group", { name: "有排出吗？", exact: true }).getByRole("button", { name: "无", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "返回", exact: false }).click();
  await expect(page.getByRole("button", { name: "继续填写 ↗" })).toBeVisible();
  await page.getByRole("button", { name: "继续填写 ↗" }).click();
  await page.getByRole("button", { name: "保存如厕记录", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "开始如厕 ↗" })).toBeVisible();
});
test("320、390、桌面无水平溢出和四页截图", async ({ page }, testInfo) => {
  await open(page);
  for (const width of [320, 390, 1000]) {
    await page.setViewportSize({ width, height: 850 });
    for (const name of ["今天", "历史", "统计", "设置"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.locator(".app-shell")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`${width}-${name}.png`),
        fullPage: true,
      });
    }
  }
});
test("多标签单计时与旧编辑拒绝覆盖", async ({ page, context }) => {
  await open(page);
  const second = await context.newPage();
  await open(second);
  await Promise.all([
    page.getByRole("button", { name: "开始如厕 ↗" }).click(),
    second.getByRole("button", { name: "开始如厕 ↗" }).click(),
  ]);
  const timer = async (p: any) =>
    p.evaluate(async () => {
      const { trackerStore } = await import(
        String("/src/state/TrackerStore.ts")
      );
      return trackerStore.getSnapshot().timer?.id;
    });
  expect(await timer(page)).toBe(await timer(second));
  await page.getByRole("button", { name: "结束如厕", exact: true }).click();
  await page.getByRole("group", { name: "有排出吗？", exact: true }).getByRole("button", { name: "无", exact: true }).click();
  await page.getByRole("button", { name: "保存如厕记录", exact: true }).click();
  await second.goto("/#today");
  await expect(second.locator(".entry")).toHaveCount(1);
  await page.locator(".entry").click();
  await second.locator(".entry").click();
  await page.getByLabel("备注（可选）").fill("合成测试 · A");
  await page.getByRole("button", { name: "保存修改" }).click();
  await second.getByLabel("备注（可选）").fill("合成测试 · B旧编辑");
  await second.getByRole("button", { name: "保存修改" }).click();
  await expect(second.getByRole("alert").first()).toContainText(
    "另一标签页修改",
  );
  await expect(second.getByLabel("备注（可选）")).toHaveValue(
    "合成测试 · B旧编辑",
  );
});
