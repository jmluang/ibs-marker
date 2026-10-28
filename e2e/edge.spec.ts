import { test, expect } from "./bff.fixture";

for (const invalid of ["start", "end", "reversed"] as const) {
  test(`日期边界：统计 ${invalid} 可修正并切回预设`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install({ time: new Date("2026-10-20T06:00:00Z") });
    await open(page);
    await page.getByRole("button", { name: "统计", exact: true }).click();
    const chip = page.getByTestId("stats-range-chip");
    const chart = page.getByTestId("stats-time-chart");
    const originalChip = await chip.getAttribute("aria-label");
    const originalChart = await chart.evaluate(el => el.outerHTML);
    const originalNotes = await page.locator(".stats-data-notes").evaluate(el => el.outerHTML);
    const originalEmpty = await page.locator(".stats-empty").textContent();
    await chip.click();
    const dialog = page.getByTestId("stats-range-dialog");
    await dialog.getByTestId("stats-range-option-custom").click();
    const start = dialog.getByTestId("stats-range-from");
    const end = dialog.getByTestId("stats-range-to");
    const confirm = dialog.getByTestId("stats-range-confirm");
    if (invalid === "start") await start.fill("");
    else if (invalid === "end") await end.fill("");
    else await start.fill("2026-10-21");
    await expect(page.locator(".stats-heading h1")).toHaveText("统计");
    await expect(dialog.getByRole("alert")).toHaveText(
      invalid === "reversed"
        ? "开始日期不能晚于结束日期，请调整日期。"
        : "请填写开始和结束日期，或选择 7 天 / 30 天。",
    );
    await expect(confirm).toBeDisabled();
    // Invalid draft must not erase or replace the last committed graph, notes or empty state.
    expect(await chart.evaluate(el => el.outerHTML)).toBe(originalChart);
    expect(await page.locator(".stats-data-notes").evaluate(el => el.outerHTML)).toBe(originalNotes);
    await expect(chip).toHaveAttribute("aria-label", originalChip!);
    await expect(page.locator(".stats-empty")).toHaveText(originalEmpty!);
    await start.fill("2026-10-18");
    await end.fill("2026-10-20");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(confirm).toBeEnabled();
    expect(await chart.evaluate(el => el.outerHTML)).toBe(originalChart);
    await expect(page.locator(".stats-completeness")).toHaveCount(7);
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("stats-day-row")).toHaveCount(3);
    await page.locator(".stats-data-notes summary").click();
    await expect(page.locator(".stats-completeness")).toHaveCount(3);
    await expect(page.locator(".stats-completeness").first()).toBeVisible();
    const committedChip = await chip.getAttribute("aria-label");
    const committedChart = await chart.evaluate(el => el.outerHTML);
    await chip.click();
    await start.fill("");
    await expect(confirm).toBeDisabled();
    // Cover all non-submitting exits across the three original boundary cases.
    if (invalid === "start") await dialog.getByTestId("stats-range-cancel").click();
    else if (invalid === "end") await dialog.getByTestId("stats-range-close").click();
    else await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(chip).toHaveAttribute("aria-label", committedChip!);
    expect(await chart.evaluate(el => el.outerHTML)).toBe(committedChart);
    await chip.click();
    await expect(start).toHaveValue("2026-10-18");
    await start.fill("");
    await dialog.getByTestId("stats-range-option-30").click();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(page.getByTestId("stats-day-row")).toHaveCount(3);
    await confirm.click();
    await expect(page.getByTestId("stats-day-row")).toHaveCount(30);
    await chip.click();
    await dialog.getByTestId("stats-range-option-7").click();
    await confirm.click();
    await expect(page.getByTestId("stats-day-row")).toHaveCount(7);
    await chip.click();
    await dialog.getByTestId("stats-range-option-custom").click();
    await expect(start).toHaveValue("2026-10-14");
    await expect(end).toHaveValue("2026-10-20");
    await dialog.getByTestId("stats-range-cancel").click();
    expect(errors).toEqual([]);
  });
}

for (const [direction, expected] of [
  ["前一天", "2026-10-19"],
  ["后一天", "2026-10-21"],
]) {
  test(`日期边界：清空历史日期后${direction}仍能导航`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install({ time: new Date("2026-10-20T06:00:00Z") });
    await open(page);
    await page.getByRole("button", { name: "历史", exact: true }).click();
    const date = page.getByLabel("历史日期");
    await date.fill("");
    await page.getByRole("button", { name: direction, exact: true }).click();
    await expect(date).toHaveValue(expected);
    await expect(page.getByRole("heading", { name: "历史", exact: true })).toBeVisible();
    await date.fill("2026-10-01");
    await expect(date).toHaveValue("2026-10-01");
    await page.getByRole("button", { name: "今天", exact: true }).click();
    await expect(page.getByRole("button", { name: "补记如厕 ＋", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("日期边界：有如厕但全部无排出保留已知零，空范围仍显示破折号", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-20T06:00:00Z") });
  await open(page);
  await page.getByRole("button", { name: "补记如厕 ＋", exact: true }).click();
  await page.getByRole("group", { name: "有排出吗？", exact: true }).getByRole("button", { name: "无", exact: true }).click();
  await page.getByRole("button", { name: "保存如厕记录", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(1);
  await page.getByRole("button", { name: "统计", exact: true }).click();
  // The approved UI removed the total strip: keep numeric semantics at the real
  // presentation boundary, and distinguish known none versus missing in the actual chart.
  const counts = (from: string, to: string) => storeCall(page,
    `const {buildStatsPresentation}=await import('/src/pages/stats/statsPresentation.ts');
     const {stats}=buildStatsPresentation(store.getSnapshot().entries, ${JSON.stringify(from)}, ${JSON.stringify(to)});
     return {toiletCount:stats.toiletCount,passedCount:stats.passedCount}`);
  expect(await counts("2026-10-14", "2026-10-20")).toEqual({ toiletCount: 1, passedCount: 0 });
  await expect(page.getByTestId("stats-time-event")).toHaveCount(1);
  await expect(page.getByTestId("stats-time-event")).toHaveAttribute("data-result", "none");
  await expect(page.getByTestId("stats-day-row").filter({ has: page.locator('[datetime="2026-10-20"]') }).locator(".stats-day-count")).toHaveText("1");
  await expect(page.locator(".stats-empty")).toHaveCount(0);
  await page.getByTestId("stats-range-chip").click();
  const dialog = page.getByTestId("stats-range-dialog");
  await dialog.getByTestId("stats-range-option-custom").click();
  await dialog.getByTestId("stats-range-from").fill("2026-10-01");
  await dialog.getByTestId("stats-range-to").fill("2026-10-02");
  await expect(page.getByTestId("stats-time-event")).toHaveCount(1);
  await dialog.getByTestId("stats-range-confirm").click();
  expect(await counts("2026-10-01", "2026-10-02")).toEqual({ toiletCount: 0, passedCount: 0 });
  await expect(page.getByTestId("stats-time-event")).toHaveCount(0);
  await expect(page.getByTestId("stats-day-row")).toHaveCount(2);
  await expect(page.locator(".stats-day-count")).toHaveText(["—", "—"]);
  await expect(page.locator(".stats-empty")).toHaveText("这个范围还没有记录。未记录不代表没有发生。");
});
async function storeCall(page: any, body: string) {
  return page.evaluate(async (body: string) => {
    const modulePath = "/src/state/TrackerStore.ts";
    const { trackerStore: store } = await import(modulePath);
    return await new Function("store", `return (async()=>{${body}})()`)(store);
  }, body);
}
async function open(page: any) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "肠记", exact: true }),
  ).toBeVisible();
}
test("三餐稍后、明确没吃、唯一餐次编辑和模板只填入", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-20T06:00:00Z") });
  await open(page);
  await page.locator(".meal-card").first().click();
  await page.getByRole("button", { name: "20 分钟后提醒" }).click();
  await expect(page.locator(".meal-card").first()).toContainText("已稍后");
  await page.locator(".meal-card").first().click();
  await page.getByRole("button", { name: "这餐没吃，确认记录" }).click();
  await expect(
    page.getByRole("group", { name: "这餐吃了吗？", exact: true }).getByRole("button", { name: "没吃", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "保存饮食记录", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(1);
  await expect(page.locator(".meal-card").first()).toContainText("明确没吃");
  await page.locator(".meal-card").first().click();
  await expect(page.getByText("编辑记录", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回", exact: false }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("新组合").fill("合成测试 · 模板");
  await page.getByRole("button", { name: "＋ 添加组合" }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("设置已保存");
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await page.getByText("其他记录 ＋").click();
  await page.getByRole("button", { name: "记录加餐 / 饮料" }).click();
  await page
    .getByRole("button", { name: "合成测试 · 模板", exact: true })
    .click();
  await expect(page.getByLabel("吃了什么、喝了什么？")).toHaveValue(
    "合成测试 · 模板",
  );
  expect(
    await storeCall(page, "return store.getSnapshot().entries.length"),
  ).toBe(1);
});
test("ordered forms、显式none清空、持久化失败留表单与身份隔离", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "补记如厕 ＋", exact: true }).click();
  await page.getByRole("group", { name: "有排出吗？", exact: true }).getByRole("button", { name: "有", exact: true }).click();
  await page.getByRole("button", { name: "2 结块", exact: true }).click();
  await page.getByRole("button", { name: "6 糊状", exact: true }).click();
  await expect(page.locator(".form-order")).toContainText("2 型");
  await page.getByRole("button", { name: "形态2上移" }).click();
  await expect(page.locator(".form-order li").first()).toContainText("6 型");
  await page.getByRole("group", { name: "有排出吗？", exact: true }).getByRole("button", { name: "无", exact: true }).click();
  await page.getByRole("group", { name: "有排出吗？", exact: true }).getByRole("button", { name: "有", exact: true }).click();
  await expect(page.locator(".form-order li")).toHaveCount(0);
  await page.getByRole("button", { name: "? 没看清", exact: true }).click();
  await page.getByLabel("备注（可选）").fill("合成测试 · 保存失败仍保留");
  await storeCall(
    page,
    "const original=store.saveEntry.bind(store);store.saveEntry=async(...args)=>{store.saveEntry=original;throw Error('SYNTHETIC_IDB_FAILURE')}",
  );
  await page.getByRole("button", { name: "保存如厕记录", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText("未能保存");
  await expect(page.getByLabel("备注（可选）")).toHaveValue(
    "合成测试 · 保存失败仍保留",
  );
  expect(
    await storeCall(page, "return store.getSnapshot().entries.length"),
  ).toBe(0);
  await page.getByRole("button", { name: "保存如厕记录", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(1);
  await storeCall(page, "await store.activate(null)");
  await expect(
    page.getByRole("button", { name: "进入本机记录" }),
  ).toBeVisible();
  await expect(page.locator(".entry")).toHaveCount(0);
  await storeCall(page, "await store.activate('user:'+crypto.randomUUID())");
  await expect(page.locator(".empty")).toBeVisible();
  await expect(page.getByText("合成测试 · 保存失败仍保留")).toHaveCount(0);
  await storeCall(page, "await store.activate('local')");
  await expect(page.locator(".entry")).toHaveCount(1);
});
test("设置草稿刷新恢复、独立资源编辑锁不被草稿绕过", async ({
  page,
  context,
}) => {
  await open(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("新组合").fill("合成测试 · 未保存设置草稿");
  await expect
    .poll(() =>
      storeCall(
        page,
        "return store.getSnapshot().drafts['settings:editor']?.template",
      ),
    )
    .toBe("合成测试 · 未保存设置草稿");
  await page.reload();
  await expect(page.getByLabel("新组合")).toHaveValue(
    "合成测试 · 未保存设置草稿",
  );
  const second = await context.newPage();
  await open(second);
  await second.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "＋ 添加组合" }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("设置已保存");
  await second.getByRole("button", { name: "＋ 添加组合" }).click();
  await second.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(second.getByRole("alert").first()).toContainText("另一标签页");
  await expect(second.getByLabel("食物组合1", { exact: true })).toHaveValue(
    "合成测试 · 未保存设置草稿",
  );
});
