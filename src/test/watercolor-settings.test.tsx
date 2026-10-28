import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

// Exercise the page's actual handlers/effects against real IndexedDB without
// adding a DOM or test-renderer dependency. Only React's hook scheduler is local.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  deps: [] as unknown[][],
  cursor: 0,
  effects: [] as (() => unknown)[],
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = hooks.cursor++;
      if (!(i in hooks.values))
        hooks.values[i] = typeof initial === "function" ? initial() : initial;
      return [
        hooks.values[i],
        (next: unknown) => {
          hooks.values[i] =
            typeof next === "function" ? next(hooks.values[i]) : next;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const i = hooks.cursor++;
      if (!(i in hooks.values)) hooks.values[i] = { current: initial };
      return hooks.values[i];
    },
    useEffect: (effect: () => unknown, deps: unknown[]) => {
      const i = hooks.cursor++;
      if (
        !hooks.deps[i] ||
        deps.some((v, n) => !Object.is(v, hooks.deps[i][n]))
      )
        hooks.effects.push(effect);
      hooks.deps[i] = deps;
    },
  };
});
vi.mock("../state/useTracker", async () => {
  const { trackerStore } = await import("../state/TrackerStore");
  return { useTracker: () => trackerStore.getSnapshot() };
});
import SettingsPage from "../pages/SettingsPage";
import { trackerStore as store } from "../state/TrackerStore";
import { defaultSettings } from "../domain/types";

type Element = ReactElement<Record<string, any>>;
let tree: ReactNode;
function render(cloudPanel?: ReactNode) {
  hooks.cursor = 0;
  tree = SettingsPage({ cloudPanel });
  for (const effect of hooks.effects.splice(0)) effect();
  return tree;
}
function elements(node = tree): Element[] {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child));
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [
    element,
    ...(element.props.children === undefined
      ? []
      : elements(element.props.children)),
  ];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement(node)) return text((node as Element).props.children);
  return typeof node === "string" || typeof node === "number"
    ? String(node)
    : "";
}
function find(predicate: (e: Element) => boolean) {
  const found = elements().find(predicate);
  expect(found, "expected page control").toBeDefined();
  return found!;
}
function button(label: string) {
  return find((e) => e.type === "button" && text(e) === label);
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
  render();
}
async function submit() {
  find((e) => e.type === "form").props.onSubmit({ preventDefault() {} });
  await settle();
}
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await store.activate("local");
  await store.clearCurrentNamespace(true);
  hooks.values = [];
  hooks.deps = [];
  hooks.effects = [];
  hooks.cursor = 0;
});
afterAll(() => {
  store.dispose();
  store.adapter.close();
});

it("has one settings title, scoped wrapper, original cloud node, and folded bundled OFL", () => {
  const signOut = vi.fn();
  const cloud = <button onClick={signOut}>真实账号退出</button>;
  render(cloud);
  expect(
    elements()
      .filter((e) => e.type === "h1")
      .map(text),
  ).toEqual(["设置"]);
  expect(
    find((e) => e.props["data-testid"] === "watercolor-settings").props
      .className,
  ).toBe("settings-page");
  expect(elements()).toContain(cloud);
  button("真实账号退出").props.onClick();
  expect(signOut).toHaveBeenCalledOnce();
  const details = find(
    (e) => e.type === "details" && text(e).includes("字体许可"),
  );
  expect(details.props.open).toBeUndefined();
  expect(text(find((e) => e.type === "pre"))).toContain(
    "SIL OPEN FONT LICENSE",
  );
  expect(renderToStaticMarkup(tree)).not.toContain("FIELDNOTES");
});

it("stages edits in the real draft queue and only applies them on explicit save", async () => {
  render();
  const original = store.getSnapshot().settings.meals.breakfast.time;
  find((e) => e.props.id === "time-breakfast").props.onChange({
    target: { value: "09:45" },
  });
  render();
  await settle();
  expect(store.getSnapshot().settings.meals.breakfast.time).toBe(original);
  expect(store.getSnapshot().drafts["settings:editor"]).toMatchObject({
    settings: { meals: { breakfast: { time: "09:45" } } },
    baseRevision: 0,
  });
  await submit();
  expect(store.getSnapshot().settings.meals.breakfast.time).toBe("09:45");
  expect(store.getSnapshot().drafts["settings:editor"]).toBeUndefined();
  expect(text(tree)).toContain("设置已保存");
});

it("recovers the settings editor and preserves trim/add/edit/delete without creating meals", async () => {
  await store.saveDraft("settings:editor", {
    settings: { ...defaultSettings(), foodTemplates: ["原组合"] },
    baseRevision: 0,
    template: "  粥、蛋  ",
  });
  render();
  await settle();
  button("＋ 添加组合").props.onClick();
  render();
  await settle();
  expect(find((e) => e.props["aria-label"] === "食物组合2").props.value).toBe(
    "粥、蛋",
  );
  find((e) => e.props["aria-label"] === "食物组合2").props.onChange({
    target: { value: "米饭" },
  });
  render();
  find((e) => e.props["aria-label"] === "删除食物组合1").props.onClick();
  render();
  await submit();
  expect(store.getSnapshot().settings.foodTemplates).toEqual(["米饭"]);
  expect(store.getSnapshot().entries).toEqual([]);
});

it("retains stale revision errors and identity fencing instead of overwriting newer settings", async () => {
  render();
  await store.saveSettings({
    ...defaultSettings(),
    foodTemplates: ["更新设置"],
  });
  await submit();
  expect(text(find((e) => e.props.role === "alert"))).toContain("另一标签页");
  expect(store.getSnapshot().settings.foodTemplates).toEqual(["更新设置"]);
  await store.activate("local");
  const saveSettings = vi.spyOn(store, "saveSettings");
  await submit();
  expect(saveSettings).not.toHaveBeenCalled();
  expect(text(find((e) => e.props.role === "alert"))).toContain("身份已切换");
});

it("only requests notification permission on the original explicit button and preserves unknown wording", async () => {
  const requestPermission = vi.fn(async () => "granted");
  vi.stubGlobal("window", { Notification: {} });
  vi.stubGlobal("Notification", { permission: "default", requestPermission });
  render();
  expect(requestPermission).not.toHaveBeenCalled();
  expect(text(tree)).toContain("未响应不代表没吃");
  expect(text(tree)).toContain("不提供后台推送");
  await find(
    (e) => e.type === "button" && text(e).startsWith("浏览器通知"),
  ).props.onClick();
  expect(requestPermission).toHaveBeenCalledOnce();
  render();
  expect(text(tree)).toContain("仅页面运行时有效");
});

it("keeps native discard confirmation and reloads only after acceptance", async () => {
  render();
  find((e) => e.props.id === "time-lunch").props.onChange({
    target: { value: "13:45" },
  });
  render();
  await settle();
  const confirm = vi.fn((_message: string) => false);
  vi.stubGlobal("confirm", confirm);
  button("放弃草稿并载入最新设置").props.onClick();
  await settle();
  expect(store.getSnapshot().drafts["settings:editor"]).toBeDefined();
  confirm.mockReturnValue(true);
  button("放弃草稿并载入最新设置").props.onClick();
  await settle();
  expect(store.getSnapshot().drafts["settings:editor"]).toBeUndefined();
  expect(find((e) => e.props.id === "time-lunch").props.value).toBe(
    defaultSettings().meals.lunch.time,
  );
});

it("exports actual JSON/CSV blobs only after sensitive-data confirmation", async () => {
  await store.saveSettings({
    ...defaultSettings(),
    foodTemplates: ["导出组合"],
  });
  render();
  const confirm = vi.fn((_message: string) => false);
  vi.stubGlobal("confirm", confirm);
  const create = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:settings-test");
  const click = vi.fn();
  const anchor = { href: "", download: "", click };
  vi.stubGlobal("document", { createElement: vi.fn(() => anchor) });
  button("下载 JSON").props.onClick();
  expect(create).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  button("下载 JSON").props.onClick();
  expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
  expect((create.mock.calls[0][0] as Blob).type).toBe(
    "application/json;charset=utf-8",
  );
  expect(anchor.download).toMatch(/\.json$/);
  expect(
    JSON.parse(await (create.mock.calls[0][0] as Blob).text()),
  ).toMatchObject({
    schemaVersion: 1,
    entries: [],
    settings: { foodTemplates: ["导出组合"] },
  });
  button("下载 CSV").props.onClick();
  expect((create.mock.calls[1][0] as Blob).type).toBe("text/csv;charset=utf-8");
  expect(await (create.mock.calls[1][0] as Blob).text()).toContain(
    '"occurredAt"',
  );
  expect(click).toHaveBeenCalledTimes(2);
  expect(confirm.mock.calls[0][0]).toContain("敏感健康记录");
});

it("retains local-only cleanup confirmation with pending-queue risk", async () => {
  await store.saveSettings({ ...defaultSettings(), foodTemplates: ["待清理"] });
  render();
  const confirm = vi.fn((_message: string) => false);
  vi.stubGlobal("confirm", confirm);
  button("清理此身份的本机数据").props.onClick();
  await settle();
  expect(store.getSnapshot().settings.foodTemplates).toEqual(["待清理"]);
  expect(confirm.mock.calls[0][0]).toContain("待同步队列有 1 项");
  expect(confirm.mock.calls[0][0]).toContain("不会删除云端数据");
  confirm.mockReturnValue(true);
  button("清理此身份的本机数据").props.onClick();
  await settle();
  expect(store.getSnapshot().settings.foodTemplates).toEqual(
    defaultSettings().foodTemplates,
  );
  expect(store.getSnapshot().outbox).toEqual([]);
});

it("uses compact scoped spacing, readable license wrapping and untouched auth styling", () => {
  const css = readFileSync(
    new URL("../pages/settings.css", import.meta.url),
    "utf8",
  );
  expect(css).toContain(".settings-page");
  expect(css).toContain("white-space: pre-wrap");
  expect(css).toContain("overflow-wrap: anywhere");
  expect(css).toContain("padding-block: 14px");
  expect(css).not.toMatch(/\.auth-|\.cloud-/);
});
