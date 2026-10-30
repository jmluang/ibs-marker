import { test, expect } from "./bff.fixture";
import type { Page, Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ToiletEntry, TrackerSnapshot } from "../src/domain/types";

// Fixture-only store introspection. All edits and final saves use the real App.
// No provider, production entrypoint, env files, real account or real record.
const synthetic = "合成验收 · 用时修正 · 非真实健康资料";
const inputName = "用时（分钟）";
test.beforeEach(async ({ context, page, baseURL }) => {
  // Preserve the shared foreign-origin firewall while allowing only the exact
  // fixture-origin Vite socket, avoiding artificial HMR console errors.
  const host = new URL(baseURL!).host;
  await context.routeWebSocket(url => url.protocol === "ws:" && url.host === host,
    socket => { socket.connectToServer(); });
  const database = `duration-e2e-${randomUUID()}`;
  await context.addInitScript(name => {
    const original = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (db, version) {
      return original.call(this, db === "ibs-marker-v1" ? name : db, version);
    };
  }, database);
  const errors: string[] = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  (page as any).__durationConsoleErrors = errors;
});
test.afterEach(async ({ page }, info) => {
  const errors = (page as any).__durationConsoleErrors ?? [];
  await info.attach("console-errors", { body: JSON.stringify(errors), contentType: "application/json" });
  expect(errors).toEqual([]);
});
async function snapshot(page: Page): Promise<TrackerSnapshot> {
  return page.evaluate(async () => {
    const { trackerStore } = await import(String("/src/state/TrackerStore.ts"));
    return trackerStore.getSnapshot();
  });
}
async function persisted(page: Page) {
  return page.evaluate(async () => {
    const { trackerStore: s } = await import(String("/src/state/TrackerStore.ts"));
    return s.adapter.read(s.identityToken().namespace);
  });
}
async function open(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("watercolor-home")).toBeVisible();
  expect((await snapshot(page)).namespace).toBe("local");
}
async function seed(page: Page, entries: ToiletEntry[]) {
  await page.evaluate(async entries => {
    const { trackerStore: s } = await import(String("/src/state/TrackerStore.ts"));
    for (const entry of entries) await s.saveEntry(entry);
  }, entries);
}
async function sample(page: Page, overrides: Partial<ToiletEntry> = {}): Promise<ToiletEntry> {
  const at = await page.evaluate(() => new Date().toISOString());
  return { id: randomUUID(), kind: "toilet", occurredAt: at, createdAt: at, updatedAt: at,
    estimatedTime: true, deletedAt: null, note: synthetic, result: "none", stoolForms: [],
    discomfort: { status: "none", symptoms: [] }, startedAt: "2020-01-01T00:00:00.123Z",
    endedAt: at, durationSource: "timer", estimatedDurationMinutes: null, relief: "unknown", ...overrides };
}
async function nav(page: Page, name: "今天" | "历史" | "统计" | "设置") {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name, exact: true }).click();
}
async function edit(page: Page, entry: ToiletEntry, from: "今天" | "历史" = "今天") {
  await nav(page, from);
  if (from === "历史") {
    const day = await page.evaluate(async at => {
      const { shanghaiDate } = await import(String("/src/domain/helpers.ts"));
      return shanghaiDate(at);
    }, entry.occurredAt);
    await page.getByLabel("历史日期", { exact: true }).fill(day);
  }
  await page.locator(".entry").filter({ hasText: entry.note }).click();
  await expect(page.getByRole("button", { name: "保存修改", exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#edit/${entry.id}$`));
}
async function duration(page: Page): Promise<Locator> {
  await expect(page.locator("form")).toBeVisible();
  const field = page.getByLabel(inputName, { exact: true });
  const modify = page.getByRole("button", { name: "修改用时", exact: true });
  if (await modify.isVisible()) await modify.click();
  if (await field.isVisible()) return field;
  // Once saved, estimated/unknown intentionally reopen in the ordinary form.
  // Unknown requires an explicit user choice before its legacy input exists.
  const estimated = page.getByLabel("估计耗时（分钟）", { exact: true });
  if (!(await estimated.isVisible())) {
    await page.getByRole("group", { name: "补记耗时", exact: true })
      .getByRole("button", { name: "估计", exact: true }).click();
  }
  await expect(estimated).toBeVisible();
  return estimated;
}
async function setDuration(page: Page, value: string) {
  const field = await duration(page);
  await field.fill(value);
  expect(await field.evaluate(el => (el as HTMLInputElement).validity.stepMismatch)).toBe(false);
  await draftSaved(page);
}
async function draftSaved(page: Page) {
  await expect(page.getByRole("status")).toContainText("草稿已保存在本机");
}
async function back(page: Page) {
  await page.getByRole("button", { name: /返回/ }).first().click();
  await expect(page.getByTestId("watercolor-home")).toBeVisible();
}
async function save(page: Page, timer = false) {
  await page.getByRole("button", { name: timer ? "保存如厕记录" : "保存修改", exact: true }).click();
  await expect(page.getByTestId("watercolor-home")).toBeVisible();
}
function invariant(before: ToiletEntry, after: ToiletEntry) {
  for (const key of ["id", "startedAt", "endedAt", "occurredAt", "estimatedTime", "createdAt"] as const)
    expect(after[key], key).toEqual(before[key]);
}
function canonical(value: unknown) {
  expect(JSON.stringify(value)).not.toMatch(/durationEdited|durationRaw|durationInput|durationExpanded/);
}
async function startFinish(page: Page) {
  await page.getByRole("button", { name: "开始如厕 ↗", exact: true }).click();
  // Only the synthetic clock start is changed; UI start and finish remain real.
  await page.evaluate(async () => {
    const { trackerStore: s } = await import(String("/src/state/TrackerStore.ts"));
    await s.adapter.transact(s.identityToken().namespace, (d: any) => {
      d.timer.startedAt = "2020-01-01T00:00:00.123Z";
      d.revision++;
    });
    await s.reload();
  });
  await page.getByRole("button", { name: "结束如厕", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存如厕记录", exact: true })).toBeVisible();
  // This exact affordance must exist before the helper can expand timer input.
  await expect(page.getByRole("button", { name: "修改用时", exact: true })).toBeVisible();
  await draftSaved(page);
  return (await snapshot(page)).timer!;
}
async function reopenTimer(page: Page) {
  await page.getByRole("button", { name: "继续填写 ↗", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存如厕记录", exact: true })).toBeVisible();
}
// Abort only AFTER a real record mutation callback in the IDB transaction.
// Draft autosaves must succeed and must never consume this injection.
async function failRecordTransaction(page: Page) {
  await page.evaluate(async () => {
    const { trackerStore: s } = await import(String("/src/state/TrackerStore.ts"));
    const original = s.adapter.transact.bind(s.adapter);
    (window as any).__durationAborts = 0;
    s.adapter.transact = (namespace: any, change: any) => original(namespace, (data: any) => {
      const records = JSON.stringify(data.records);
      const result = change(data);
      if (records !== JSON.stringify(data.records)) {
        s.adapter.transact = original;
        (window as any).__durationAborts++;
        throw Error("INJECTED_RECORD_TRANSACTION_FAILURE");
      }
      return result;
    });
  });
}
async function failedSave(page: Page, timer = false) {
  await page.getByRole("button", { name: timer ? "保存如厕记录" : "保存修改", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__durationAborts)).toBe(1);
  await expect(page.getByRole("alert").first()).toBeVisible();
}

for (const from of ["今天", "历史"] as const) {
  test(`已保存巨大计时从${from}修正7.125，同ID同clock且重开正确`, async ({ page }) => {
    await open(page);
    const original = await sample(page);
    await seed(page, [original]);
    const before = await snapshot(page);
    await edit(page, original, from);
    // Core baseline RED: form is proven mounted before this exact assertion.
    await expect(page.getByRole("button", { name: "修改用时", exact: true })).toBeVisible();
    await setDuration(page, "7.125");
    await save(page);
    const after = await snapshot(page);
    expect(Object.keys(after.records)).toEqual([original.id]);
    expect(after.editRevisions[original.id]).toBe(before.editRevisions[original.id] + 1);
    const entry = after.records[original.id] as ToiletEntry;
    invariant(original, entry);
    expect(entry.updatedAt).not.toBe(original.updatedAt);
    expect(entry).toMatchObject({ durationSource: "estimated", estimatedDurationMinutes: 7.125 });
    expect(after.outbox).toHaveLength(1);
    expect(after.outbox[0]).toMatchObject({ resourceId: original.id, snapshot: entry });
    canonical(entry); canonical(after.outbox);
    await edit(page, original);
    await expect(await duration(page)).toHaveValue("7.125");
    await page.reload();
    await expect(await duration(page)).toHaveValue("7.125");
  });
}

test("UI开始结束→6.5→返回刷新恢复→成功才清对应timer", async ({ page }) => {
  await open(page);
  const timer = await startFinish(page);
  await setDuration(page, "6.5");
  await back(page);
  expect((await persisted(page)).timer).toEqual(timer);
  await page.reload(); await reopenTimer(page);
  await expect(await duration(page)).toHaveValue("6.5");
  await save(page, true);
  const s = await persisted(page);
  expect(s.timer).toBeNull();
  expect(Object.keys(s.records)).toEqual([timer.id]);
  expect(s.records[timer.id]).toMatchObject({ id: timer.id, startedAt: timer.startedAt,
    endedAt: timer.endedAt, occurredAt: timer.startedAt, durationSource: "estimated", estimatedDurationMinutes: 6.5 });
  canonical(s.records); canonical(s.outbox);
});

test("timer-form 首次直接0：失败保timer、成功同ID同clock且只清匹配草稿", async ({ page }, info) => {
  await open(page);
  const timer = await startFinish(page);
  expect(Object.keys((await persisted(page)).records)).toEqual([]);
  const unrelated = await sample(page, { note: `${synthetic} · unrelated-draft` });
  await page.evaluate(async entry => {
    const { trackerStore: s } = await import(String("/src/state/TrackerStore.ts"));
    await s.saveDraft(`edit:${entry.id}`, { entry, baseRevision: 0, editing: true });
  }, unrelated);
  await setDuration(page, "0");
  const before = await persisted(page);
  await failRecordTransaction(page); await failedSave(page, true);
  const failed = await persisted(page);
  expect(failed.timer).toEqual(timer);
  expect(failed.records).toEqual(before.records);
  expect(failed.outbox).toEqual(before.outbox);
  await expect(await duration(page)).toHaveValue("0");
  await save(page, true);
  const final = await persisted(page);
  expect(final.timer).toBeNull();
  expect(Object.keys(final.records)).toEqual([timer.id]);
  expect(final.records[timer.id]).toMatchObject({ id: timer.id, startedAt: timer.startedAt,
    endedAt: timer.endedAt, occurredAt: timer.startedAt, durationSource: "estimated", estimatedDurationMinutes: 0 });
  expect(final.drafts[`timer:${timer.id}`]).toBeUndefined();
  expect(final.drafts[`edit:${unrelated.id}`]).toEqual(before.drafts[`edit:${unrelated.id}`]);
  expect(final.outbox).toHaveLength(1);
  expect(final.outbox[0]).toMatchObject({ resourceId: timer.id, snapshot: final.records[timer.id] });
  canonical(final.records); canonical(final.outbox);
  await info.attach("first-finalize-zero", { body: JSON.stringify({ timer, failed, final }), contentType: "application/json" });
});

for (const timer of [false, true]) {
  test(`${timer ? "timer-form" : "record-edit"} 清空unknown与零known独立保存`, async ({ page }) => {
    await open(page);
    const original = timer ? null : await sample(page);
    if (original) { await seed(page, [original]); await edit(page, original); }
    const active = timer ? await startFinish(page) : null;
    const id = original?.id ?? active!.id;
    await setDuration(page, ""); await save(page, timer);
    expect((await persisted(page)).records[id]).toMatchObject({ durationSource: "unknown", estimatedDurationMinutes: null });
    const current = (await snapshot(page)).records[id] as ToiletEntry;
    // The deliberately ancient timer seed saves to its start day, not today.
    await edit(page, current, timer ? "历史" : "今天");
    await setDuration(page, "0"); await save(page);
    expect((await persisted(page)).records[id]).toMatchObject({ durationSource: "estimated", estimatedDurationMinutes: 0 });
  });
  test(`${timer ? "timer-form" : "record-edit"} 非法raw阻保存且refresh保留可修复，大有限数无上限`, async ({ page }) => {
    await open(page);
    const original = timer ? null : await sample(page);
    if (original) { await seed(page, [original]); await edit(page, original); }
    if (timer) await startFinish(page);
    await page.getByRole("textbox", { name: "备注（可选）", exact: true }).fill(`${synthetic} · raw保留`);
    const before = await persisted(page);
    for (const raw of ["-", "-1", "NaN", "Infinity", "1e309"]) {
      await setDuration(page, raw);
      await expect(await duration(page)).toHaveValue(raw);
      const submit = page.getByRole("button", { name: timer ? "保存如厕记录" : "保存修改", exact: true });
      if (await submit.isEnabled()) await submit.click();
      await expect(page.locator("form")).toBeVisible();
      const state = await persisted(page);
      expect(state.records).toEqual(before.records); expect(state.outbox).toEqual(before.outbox); expect(state.timer).toEqual(before.timer);
    }
    await page.reload();
    await expect(await duration(page)).toHaveValue("1e309");
    await expect(page.getByRole("textbox", { name: "备注（可选）", exact: true })).toHaveValue(`${synthetic} · raw保留`);
    await setDuration(page, "1e100"); await save(page, timer);
    const values = Object.values((await persisted(page)).records) as ToiletEntry[];
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ durationSource: "estimated", estimatedDurationMinutes: 1e100 });
  });
  test(`${timer ? "timer-form" : "record-edit"} 事务真实回滚、discard取消、返回刷新重试`, async ({ page }) => {
    await open(page);
    const original = timer ? null : await sample(page);
    if (original) { await seed(page, [original]); await edit(page, original); }
    if (timer) await startFinish(page);
    await setDuration(page, "7.125");
    page.once("dialog", dialog => dialog.dismiss());
    await page.getByRole("button", { name: timer ? "丢弃本次计时和草稿" : "丢弃草稿", exact: true }).click();
    await expect(await duration(page)).toHaveValue("7.125");
    const before = await persisted(page);
    await failRecordTransaction(page); await failedSave(page, timer);
    const failed = await persisted(page);
    expect(failed.records).toEqual(before.records); expect(failed.outbox).toEqual(before.outbox); expect(failed.timer).toEqual(before.timer);
    await expect(await duration(page)).toHaveValue("7.125");
    await back(page); await page.reload();
    if (timer) await reopenTimer(page); else await edit(page, original!);
    await expect(await duration(page)).toHaveValue("7.125");
    await save(page, timer);
    const final = await persisted(page);
    expect(Object.values(final.records)[0]).toMatchObject({ durationSource: "estimated", estimatedDurationMinutes: 7.125 });
    if (timer) expect(final.timer).toBeNull();
  });
}

test("toggle/focus/相同值/备注保存保原timer毫秒精度，无durationEdited", async ({ page }) => {
  await open(page);
  const original = await sample(page, { startedAt: "2026-01-01T00:00:00.123Z", endedAt: "2026-01-01T00:07:07.987Z" });
  await seed(page, [original]); await edit(page, original);
  const field = await duration(page);
  await field.focus();
  const same = await field.inputValue(); await field.fill(same);
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await expect(field).toBeHidden();
  await page.getByRole("textbox", { name: "备注（可选）", exact: true }).fill(`${synthetic} · 仅备注`);
  await draftSaved(page);
  const draft = (await persisted(page)).drafts[`edit:${original.id}`] as any;
  expect(draft.durationEdited).not.toBe(true);
  await save(page);
  const after = (await persisted(page)).records[original.id] as ToiletEntry;
  invariant(original, after);
  expect(after.durationSource).toBe("timer"); expect(after.estimatedDurationMinutes).toBeNull();
});

test("旧timer草稿缺marker且sourceunknown仍按clock显示并timer/null保存", async ({ page }) => {
  await open(page); const timer = await startFinish(page);
  await back(page);
  await page.evaluate(async id => {
    const { trackerStore: s } = await import(String("/src/state/TrackerStore.ts"));
    await s.adapter.transact(s.identityToken().namespace, (d: any) => {
      const draft = d.drafts[`timer:${id}`];
      d.drafts[`timer:${id}`] = { entry: { ...draft.entry, durationSource: "unknown", estimatedDurationMinutes: null },
        baseRevision: draft.baseRevision, editing: false };
      d.revision++;
    }); await s.reload();
  }, timer.id);
  await page.reload(); await reopenTimer(page);
  await expect(page.getByText(/计时时长/).first()).toBeVisible();
  await save(page, true);
  expect((await persisted(page)).records[timer.id]).toMatchObject({ durationSource: "timer", estimatedDurationMinutes: null,
    startedAt: timer.startedAt, endedAt: timer.endedAt });
});

test("已有estimated/unknown与旧普通编辑draft保原source；非如厕无用时字段", async ({ page }) => {
  await open(page);
  for (const source of ["estimated", "unknown"] as const) {
    const entry = await sample(page, { durationSource: source, estimatedDurationMinutes: source === "estimated" ? 7.125 : null, note: `${synthetic} · ${source}` });
    await seed(page, [entry]);
    await page.evaluate(async entry => {
      const { trackerStore: s } = await import(String("/src/state/TrackerStore.ts"));
      await s.saveDraft(`edit:${entry.id}`, { entry, baseRevision: s.getEditRevision(entry.id), editing: true });
    }, entry);
    await edit(page, entry);
    await page.getByRole("textbox", { name: "备注（可选）", exact: true }).fill(`${entry.note} · 备注`); await save(page);
    expect((await persisted(page)).records[entry.id]).toMatchObject({ durationSource: source, estimatedDurationMinutes: entry.estimatedDurationMinutes });
  }
  for (const route of ["new/meal/snack", "new/symptom"]) {
    await page.goto(`/#${route}`);
    await expect(page.locator("form")).toBeVisible();
    await expect(page.getByLabel(inputName, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "修改用时", exact: true })).toHaveCount(0);
    await back(page);
  }
});

for (const ended of [false, true]) {
  test(`普通编辑不触碰当前${ended ? "ended" : "active"} timer：open/cancel/fail/success/reload`, async ({ page }) => {
    await open(page);
    const original = await sample(page); await seed(page, [original]);
    await page.evaluate(async ended => {
      const { trackerStore: s } = await import(String("/src/state/TrackerStore.ts"));
      await s.startTimer("2020-01-01T00:00:00.123Z");
      if (ended) await s.finishTimer("2020-01-01T00:07:07.987Z");
      (window as any).__durationTimerCalls = [];
      for (const name of ["startTimer", "finishTimer", "saveTimerDraft", "cancelTimer", "finalizeTimer"]) {
        const original = s[name].bind(s);
        s[name] = (...args: any[]) => { (window as any).__durationTimerCalls.push(name); return original(...args); };
      }
    }, ended);
    const timer = (await persisted(page)).timer;
    await edit(page, original); expect((await persisted(page)).timer).toEqual(timer);
    await setDuration(page, "7.125");
    page.once("dialog", d => d.dismiss()); await page.getByRole("button", { name: "丢弃草稿", exact: true }).click();
    expect((await persisted(page)).timer).toEqual(timer);
    await failRecordTransaction(page); await failedSave(page);
    expect((await persisted(page)).timer).toEqual(timer);
    await save(page); expect((await persisted(page)).timer).toEqual(timer);
    expect(await page.evaluate(() => (window as any).__durationTimerCalls)).toEqual([]);
    await page.reload(); await expect(page.getByTestId("watercolor-home")).toBeVisible();
    expect((await persisted(page)).timer).toEqual(timer);
  });
}

for (const timer of [false, true]) {
  test(`${timer ? "首次finalize" : "普通编辑"} 另一事务同ID写入触发STALE_REVISION不覆盖`, async ({ page }) => {
    await open(page);
    const entry = await sample(page);
    if (!timer) { await seed(page, [entry]); await edit(page, entry); }
    const active = timer ? await startFinish(page) : null;
    const id = active?.id ?? entry.id;
    await setDuration(page, "7.125");
    const rival = { ...entry, id, note: `${synthetic} · 并发赢家`, durationSource: "estimated" as const, estimatedDurationMinutes: 12 };
    await page.evaluate(async rival => {
      const { trackerStore: s } = await import(String("/src/state/TrackerStore.ts"));
      // Independent durable transaction, no publish: editor retains its captured revision.
      await s.adapter.transact(s.identityToken().namespace, (d: any) => {
        d.records[rival.id] = rival; d.editRevisions[rival.id] = (d.editRevisions[rival.id] ?? 0) + 1;
        d.outbox = d.outbox.filter((op: any) => op.resourceId !== rival.id);
        d.outbox.push({ kind: "entry", resourceId: rival.id, snapshot: rival, changeId: crypto.randomUUID(), baseVersion: 0, tombstone: false });
        d.revision++;
      });
    }, rival);
    const before = await persisted(page);
    await page.getByRole("button", { name: timer ? "保存如厕记录" : "保存修改", exact: true }).click();
    await expect(page.getByRole("alert").first()).toContainText(/其他页面|更新|冲突|重新/);
    const after = await persisted(page);
    expect(after.records).toEqual(before.records); expect(after.outbox).toEqual(before.outbox); expect(after.timer).toEqual(before.timer);
    await expect(await duration(page)).toHaveValue("7.125");
  });
}

// Parse the actual downloaded CSV, including quoted cells, rather than substring-only evidence.
function csvRows(text: string) {
  const rows: string[][] = []; let row: string[] = [], value = "", quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && c === ",") { row.push(value); value = ""; }
    else if (!quoted && (c === "\r" || c === "\n")) { if (c === "\r" && text[i + 1] === "\n") i++; row.push(value); rows.push(row); row = []; value = ""; }
    else value += c;
  }
  if (row.length || value) { row.push(value); rows.push(row); }
  return rows.slice(1).map(values => Object.fromEntries(rows[0].map((key, i) => [key, values[i]])));
}
test("修正helper→Timeline/统计known零与unknown→真实JSON/CSV下载无UI元数据", async ({ page }) => {
  await open(page);
  const entries: ToiletEntry[] = [];
  for (const [index, raw] of ["7.125", "0", ""].entries()) {
    const entry = await sample(page, { note: `${synthetic} · export-${index}` });
    await seed(page, [entry]); await edit(page, entry); await setDuration(page, raw); await save(page);
    entries.push((await persisted(page)).records[entry.id] as ToiletEntry);
  }
  await expect(page.locator(".entry").filter({ hasText: "export-0" })).toContainText("7.125");
  await expect(page.locator(".entry").filter({ hasText: "export-1" })).toContainText(/0.*分钟/);
  await expect(page.locator(".entry").filter({ hasText: "export-2" })).toContainText(/时长未知|用时未知/);
  const values = await page.evaluate(async entries => {
    const { durationMinutes } = await import(String("/src/domain/helpers.ts"));
    return entries.map((entry: any) => durationMinutes(entry));
  }, entries);
  expect(values).toEqual([7.125, 0, null]);
  await nav(page, "统计");
  await expect(page.getByText(/时长已知 2 条 · 缺失 1/)).toBeVisible();
  await expect(page.locator(".stats-compact-row").filter({ hasText: "平均用时" })).toContainText("3.6");
  await nav(page, "设置");
  for (const format of ["JSON", "CSV"]) {
    page.once("dialog", d => d.accept());
    const event = page.waitForEvent("download");
    await page.getByRole("button", { name: `下载 ${format}`, exact: true }).click();
    const download = await event; const path = await download.path(); expect(path).not.toBeNull();
    const content = await readFile(path!, "utf8"); canonical(content);
    if (format === "JSON") {
      const data = JSON.parse(content); expect(data.entries).toHaveLength(3);
      for (const entry of entries) expect(data.entries.find((e: any) => e.id === entry.id)).toEqual(entry);
    } else {
      const rows = csvRows(content); expect(rows).toHaveLength(3);
      for (const entry of entries) {
        const row = rows.find(row => row.id === entry.id)!;
        for (const key of ["startedAt", "endedAt", "occurredAt", "createdAt", "durationSource"] as const) expect(row[key]).toBe(entry[key]);
        expect(row.estimatedDurationMinutes).toBe(entry.estimatedDurationMinutes === null ? "" : String(entry.estimatedDurationMinutes));
      }
    }
  }
});

for (const width of [320, 390, 1280]) {
  test(`${width}px两入口真实非空修正保存、44px目标、紧凑且无新Hero或水平溢出`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 850 }); await open(page);
    const evidence: unknown[] = [];
    for (const timerForm of [false, true]) {
      const entrypoint = timerForm ? "timer-form" : "saved-edit";
      const hero = await page.locator(".last-card").boundingBox();
      const before = await persisted(page);
      expect(before.timer).toBeNull();
      const entry = timerForm ? null : await sample(page);
      if (entry) { await seed(page, [entry]); await edit(page, entry); }
      const timer = timerForm ? await startFinish(page) : null;
      const id = entry?.id ?? timer!.id;
      expect(before.records[id]).toBeUndefined();
      const button = page.getByRole("button", { name: "修改用时", exact: true });
      await expect(button).toBeVisible(); await button.scrollIntoViewIfNeeded();
      const buttonBox = (await button.boundingBox())!;
      expect(buttonBox.width).toBeGreaterThanOrEqual(44); expect(buttonBox.height).toBeGreaterThanOrEqual(44);
      const field = await duration(page);
      await field.scrollIntoViewIfNeeded(); await expect(field).toBeInViewport();
      const fieldBox = (await field.boundingBox())!;
      expect(fieldBox.width).toBeGreaterThanOrEqual(44); expect(fieldBox.height).toBeGreaterThanOrEqual(44);
      await setDuration(page, "7.125"); await expect(field).toHaveValue("7.125");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator(".form-page h1").count()).toBe(0);
      await page.screenshot({ path: info.outputPath(`duration-${width}-${entrypoint}.png`), fullPage: true });
      await save(page, timerForm);
      const final = await persisted(page);
      expect(final.records[id]).toMatchObject({ id, durationSource: "estimated", estimatedDurationMinutes: 7.125 });
      if (entry) invariant(entry, final.records[id] as ToiletEntry);
      if (timer) {
        expect(final.records[id]).toMatchObject({ startedAt: timer.startedAt, endedAt: timer.endedAt, occurredAt: timer.startedAt });
        expect(Object.keys(final.records).sort()).toEqual([...Object.keys(before.records), id].sort());
        for (const [otherId, other] of Object.entries(before.records)) expect(final.records[otherId]).toEqual(other);
        expect(final.drafts[`timer:${id}`]).toBeUndefined();
      }
      expect(final.timer).toBeNull();
      expect((await page.locator(".last-card").boundingBox())!.height).toBe(hero!.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth)).toBe(true);
      evidence.push({ width, entrypoint, id, buttonBox, fieldBox, timer, saved: final.records[id] });
    }
    await info.attach("two-entrypoint-geometry-and-save", { body: JSON.stringify(evidence), contentType: "application/json" });
  });
}
