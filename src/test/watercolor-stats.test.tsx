import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import StatsPage, { addDay, dateRangeError } from "../pages/StatsPage";
import {
  buildStatsPresentation,
  layoutEvents,
} from "../pages/stats/statsPresentation";
import { isolateBackground } from "../pages/stats/StatsModal";
import { defaultSettings, type Entry, type ToiletEntry } from "../domain/types";

const toilet = (id: string, patch: Partial<ToiletEntry> = {}): ToiletEntry => ({
  id,
  kind: "toilet",
  occurredAt: "2026-10-23T00:00:00+08:00",
  createdAt: "2026-10-23T00:00:00Z",
  updatedAt: "2026-10-23T00:00:00Z",
  estimatedTime: false,
  deletedAt: null,
  note: "",
  result: "passed",
  stoolForms: [4],
  discomfort: { status: "none", symptoms: [] },
  startedAt: null,
  endedAt: null,
  durationSource: "unknown",
  estimatedDurationMinutes: null,
  relief: "unknown",
  ...patch,
});

describe("watercolor statistics real data boundaries", () => {
  it("allows exactly 366 inclusive days and rejects 367, missing, invalid and reversed dates", () => {
    expect(dateRangeError("2024-01-01", "2024-12-31")).toBe("");
    expect(dateRangeError("2024-01-01", "2025-01-01")).toContain("366");
    expect(dateRangeError("2023-03-01", "2024-02-29")).toBe("");
    expect(dateRangeError("", "2024-01-01")).not.toBe("");
    expect(dateRangeError("2023-02-29", "2024-01-01")).not.toBe("");
    expect(dateRangeError("2024-01-02", "2024-01-01")).not.toBe("");
    expect(addDay("2024-02-28", 1)).toBe("2024-02-29");
  });
  it("groups UTC timestamps into Shanghai dates and keeps 00:00 and 23:59 at the true x", () => {
    const p = buildStatsPresentation(
      [
        toilet("midnight", { occurredAt: "2026-10-22T16:00:00Z" }),
        toilet("last", { occurredAt: "2026-10-23T15:59:00Z" }),
        toilet("tomorrow", { occurredAt: "2026-10-23T16:00:00Z" }),
        toilet("deleted", { deletedAt: "2026-10-23T00:00:00Z" }),
      ],
      "2026-10-23",
      "2026-10-23",
    );
    expect(p.entries.map((e) => e.id)).toEqual(["midnight", "last"]);
    expect(p.rows[0].events.map((e) => e.minute)).toEqual([0, 1439]);
    expect(p.byDay.get("2026-10-23")).toHaveLength(2);
  });
  it.each([3, 8])(
    "stacks %i dense events vertically and grows the whole date row",
    (count) => {
      const events = Array.from({ length: count }, (_, i) => toilet(String(i)));
      const layout = layoutEvents(events);
      expect(layout.events.map((e) => e.lane)).toEqual(
        Array.from({ length: count }, (_, i) => i),
      );
      expect(layout.events.every((e) => e.minute === 0)).toBe(true);
      expect(layout.height).toBeGreaterThanOrEqual(count * 19);
    },
  );
  it("uses shape-item, known-duration, and known-status denominators without treating missing as zero", () => {
    const entries: Entry[] = [
      toilet("multi", {
        stoolForms: [3, 4, "unknown"],
        durationSource: "estimated",
        estimatedDurationMinutes: 0,
      }),
      toilet("empty", { stoolForms: [] }),
      toilet("none", {
        result: "none",
        stoolForms: [7],
        durationSource: "estimated",
        estimatedDurationMinutes: Infinity,
        discomfort: { status: "unknown", symptoms: [] },
      }),
      {
        ...toilet("symptom"),
        kind: "symptom",
        context: "",
        discomfort: {
          status: "reported",
          symptoms: [{ name: "pain", severity: "mild" }],
        },
      },
    ];
    const p = buildStatsPresentation(entries, "2026-10-23", "2026-10-23");
    expect(p.stats.stoolKnownSegments).toBe(2);
    expect(p.stats.stoolForms.unknown).toBe(1);
    expect(p.stats.stoolForms[7]).toBe(0);
    expect(p.shapeMissing).toBe(1);
    expect(p.stats.durationKnown).toBe(1);
    expect(p.stats.averageDurationMinutes).toBe(0);
    expect(p.stats.durationMissing).toBe(2);
    expect(p.stats.discomfortKnown).toBe(3);
    expect(p.stats.discomfortReported).toBe(1);
    expect(p.stats.discomfortUnknown).toBe(1);
  });
  it("does not truncate long ranges or confuse meal absence with explicit skipped", () => {
    const meal: Entry = {
      ...toilet("meal"),
      kind: "meal",
      slot: "breakfast",
      status: "skipped",
      foods: "",
      tags: [],
      portion: "unknown",
    };
    const p = buildStatsPresentation([meal], "2026-10-01", "2026-11-02");
    expect(p.rows).toHaveLength(33);
    expect(p.meals.get("2026-10-23")?.get("breakfast")?.[0].status).toBe(
      "skipped",
    );
    expect(p.meals.get("2026-10-22")).toBeUndefined();
  });
  it("renders one h1, a committed range chip, and no obsolete total-count bar", () => {
    const html = renderToStaticMarkup(
      <StatsPage entries={[]} settings={defaultSettings()} />,
    );
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('data-testid="watercolor-stats"');
    expect(html).toContain('data-testid="stats-range-chip"');
    expect(html).toContain('data-testid="stats-time-chart"');
    expect(html).not.toContain("如厕次数");
    expect(html).not.toContain("示例数据");
  });
});

// Real DOM lifecycle acceptance is isolated to loopback synthetic records; no app/cloud bootstrap.
describe("statistics browser lifecycle and memo", () => {
  let server: ViteDevServer;
  let browser: Browser;
  let page: Page;
  let origin: string;
  beforeAll(async () => {
    const fixture = `import React, {StrictMode} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import StatsPage from '/src/pages/StatsPage.tsx';
      import {isolateBackground} from '/src/pages/stats/StatsModal.tsx';
      window.isolateBackground=isolateBackground;
      import {defaultSettings} from '/src/domain/types.ts';
      import {shanghaiDate} from '/src/domain/helpers.ts';
      const today=shanghaiDate(new Date().toISOString());
      const settings=defaultSettings();
      window.analyses=0;
      const entries=new Proxy(Array.from({length:8},(_,i)=>({id:'synthetic-'+i,kind:'toilet',occurredAt:today+'T00:00:00+08:00',createdAt:today+'T00:00:00+08:00',updatedAt:today+'T00:00:00+08:00',estimatedTime:true,deletedAt:null,note:'',result:['passed','none','unsure'][i%3],stoolForms:i%3===0?[3,4,'unknown']:[],discomfort:{status:'none',symptoms:[]},startedAt:null,endedAt:null,durationSource:'estimated',estimatedDurationMinutes:0,relief:'unknown'})),{get(target,key){if(key===Symbol.iterator){window.analyses++; return target[Symbol.iterator].bind(target)} return Reflect.get(target,key)}});
      const root=createRoot(document.querySelector('#application'));
      let generation=0;
      window.renderStats=()=>flushSync(()=>root.render(<StrictMode><div><StatsPage key={generation} entries={entries} settings={settings}/><nav><button id='nav-button'>其他页</button></nav></div></StrictMode>));
      window.replaceIdentity=()=>{generation++;window.renderStats()};
      window.unmountStats=()=>flushSync(()=>root.render(<button id='auth-lock'>身份已锁定</button>));
      window.renderStats();`;
    server = await createServer({
      configFile: false,
      envDir: false,
      root: process.cwd(),
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        {
          name: "isolated-stats-fixture",
          resolveId(id) {
            if (id === "/__stats_fixture.tsx") return id;
          },
          load(id) {
            if (id === "/__stats_fixture.tsx") return fixture;
          },
          configureServer(viteServer) {
            viteServer.middlewares.use(
              "/__stats_fixture.html",
              async (_req, res) => {
                res.setHeader("Content-Type", "text/html");
                res.end(
                  await viteServer.transformIndexHtml(
                    "/__stats_fixture.html",
                    '<!doctype html><html><head></head><body><div id="previously-inert" inert><button>Already isolated</button></div><div id="application" style="--font-hand:serif;max-width:390px;margin:auto"></div><script type="module" src="/__stats_fixture.tsx"></script></body></html>',
                  ),
                );
              },
            );
          },
        },
        react(),
      ],
    });
    await server.listen();
    const address = server.httpServer!.address() as { port: number };
    origin = `http://127.0.0.1:${address.port}`;
    const cache = join(homedir(), ".cache/ms-playwright");
    const cachedChromium = existsSync(cache)
      ? readdirSync(cache)
          .filter((name) => /^chromium-\d+$/.test(name))
          .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
          .flatMap((name) => [
            join(cache, name, "chrome-linux64/chrome"),
            join(cache, name, "chrome-linux/chrome"),
          ])
          .find(existsSync)
      : undefined;
    const executablePath =
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
      (existsSync(chromium.executablePath())
        ? chromium.executablePath()
        : cachedChromium);
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5000);
    page.on("pageerror", (error) =>
      console.error("stats fixture browser:", error.message),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        console.error("stats fixture console:", message.text());
    });
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin)
        ? route.continue()
        : route.abort(),
    );
  }, 30000);
  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await server?.close();
  });
  const load = async () => {
    await page.goto(`${origin}/__stats_fixture.html`);
    try {
      await page.getByTestId("stats-range-chip").waitFor();
    } catch (error) {
      console.error("fixture HTML", await page.content());
      throw error;
    }
  };
  it("keeps analysis memoized on stable parent ticks and distinguishes all estimated results", async () => {
    await load();
    const before = await page.evaluate(() => (window as any).analyses);
    for (let i = 0; i < 3; i++)
      await page.evaluate(() => (window as any).renderStats());
    expect(await page.evaluate(() => (window as any).analyses)).toBe(before);
    const events = page.getByTestId("stats-time-event");
    expect(await events.count()).toBe(8);
    for (const [result, glyph] of [
      ["passed", "●"],
      ["none", "×"],
      ["unsure", "?"],
    ]) {
      const event = events
        .filter({ has: page.locator(`span`, { hasText: glyph }) })
        .first();
      expect(await event.getAttribute("data-result")).toBe(result);
      expect(await event.textContent()).toContain("~");
    }
    const row = page.getByTestId("stats-day-row").first();
    expect(
      await row.evaluate((node) => node.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(8 * 19);
    const positions = await row
      .getByTestId("stats-time-event")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const r = node.getBoundingClientRect();
          return { x: r.x, bottom: r.bottom };
        }),
      );
    expect(new Set(positions.map((position) => position.x)).size).toBe(1);
    expect(
      Math.max(...positions.map((position) => position.bottom)),
    ).toBeLessThanOrEqual(
      await row.evaluate((node) => node.getBoundingClientRect().bottom),
    );
    await page.setViewportSize({ width: 320, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
    await page.setViewportSize({ width: 390, height: 844 });
  }, 20000);
  it("does not commit pending ranges; confirms exactly 366 and refuses 367, blank and reversed", async () => {
    await load();
    const chip = page.getByTestId("stats-range-chip");
    const original = await chip.textContent();
    await chip.click();
    await page.getByTestId("stats-range-option-30").click();
    expect(await chip.textContent()).toBe(original);
    await page.getByTestId("stats-range-cancel").click();
    expect(await chip.textContent()).toBe(original);
    expect(await chip.evaluate((node) => node === document.activeElement)).toBe(
      true,
    );
    await chip.click();
    await page.getByTestId("stats-range-option-custom").click();
    const from = page.getByTestId("stats-range-from"),
      to = page.getByTestId("stats-range-to"),
      confirm = page.getByTestId("stats-range-confirm");
    await from.fill("2024-01-01");
    await to.fill("2025-01-01");
    expect(await confirm.isDisabled()).toBe(true);
    await from.fill("");
    expect(await confirm.isDisabled()).toBe(true);
    await from.fill("2025-01-02");
    expect(await confirm.isDisabled()).toBe(true);
    await from.fill("2024-01-01");
    await to.fill("2024-12-31");
    expect(await confirm.isEnabled()).toBe(true);
    await confirm.click();
    expect(await chip.textContent()).toContain("自定义");
    expect(await page.getByTestId("stats-day-row").count()).toBe(366);
    expect(await chip.evaluate((node) => node === document.activeElement)).toBe(
      true,
    );
  }, 20000);
  it("isolates the entire app, traps Tab skipping disabled controls, and restores exact inert states", async () => {
    await load();
    await page.getByTestId("stats-range-chip").click();
    expect(await page.locator(".stats-modal-root").count()).toBe(1);
    expect(
      await page
        .locator("#application")
        .evaluate((node) => (node as HTMLElement).inert),
    ).toBe(true);
    expect(
      await page
        .getByTestId("stats-range-dialog")
        .evaluate((node) => !!node.closest("[inert]")),
    ).toBe(false);
    expect(
      await page
        .locator(".stats-modal-root")
        .evaluate((node) =>
          getComputedStyle(node).getPropertyValue("--font-hand"),
        ),
    ).toBe("serif");
    await page.getByTestId("stats-range-option-custom").click();
    await page.getByTestId("stats-range-from").fill("");
    await page.getByTestId("stats-range-cancel").focus();
    await page.keyboard.press("Tab");
    expect(
      await page
        .getByTestId("stats-range-close")
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page.keyboard.press("Shift+Tab");
    expect(
      await page
        .getByTestId("stats-range-cancel")
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page
      .locator("#nav-button")
      .evaluate((node) => (node as HTMLElement).focus());
    expect(
      await page
        .getByTestId("stats-range-dialog")
        .evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.locator(".stats-modal-root").count()).toBe(0);
    expect(
      await page
        .locator("#application")
        .evaluate((node) => (node as HTMLElement).inert),
    ).toBe(false);
    expect(
      await page
        .locator("#previously-inert")
        .evaluate((node) => (node as HTMLElement).inert),
    ).toBe(true);
    expect(
      await page
        .getByTestId("stats-range-chip")
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
  }, 20000);
  it("cancels backdrop and route-change, clears old-generation portals without focusing old identities", async () => {
    await load();
    const original = await page.getByTestId("stats-range-chip").textContent();
    await page.getByTestId("stats-range-chip").click();
    await page.getByTestId("stats-range-option-30").click();
    await page
      .locator(".stats-modal-backdrop")
      .click({ position: { x: 3, y: 3 } });
    expect(await page.getByTestId("stats-range-chip").textContent()).toBe(
      original,
    );
    await page.getByTestId("stats-range-chip").click();
    await page.evaluate(() => {
      location.hash = "history";
    });
    await page.getByTestId("stats-range-dialog").waitFor({ state: "detached" });
    expect(
      await page
        .locator("#application")
        .evaluate((node) => (node as HTMLElement).inert),
    ).toBe(false);
    await page.getByTestId("stats-range-chip").click();
    await page.evaluate(() => (window as any).replaceIdentity());
    expect(await page.locator(".stats-modal-root").count()).toBe(0);
    expect(
      await page
        .locator("#application")
        .evaluate((node) => (node as HTMLElement).inert),
    ).toBe(false);
    await page.getByTestId("stats-range-chip").click();
    await page.evaluate(() => {
      (window as any).unmountStats();
      document.querySelector<HTMLElement>("#auth-lock")?.focus();
    });
    await page.keyboard.press("Escape");
    expect(await page.locator(".stats-modal-root").count()).toBe(0);
    expect(
      await page
        .locator("#auth-lock")
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    expect(
      await page
        .locator("#previously-inert")
        .evaluate((node) => (node as HTMLElement).inert),
    ).toBe(true);
  }, 20000);
  it("confirms 30 and 7 day presets but discards pending changes with X", async () => {
    await load();
    const chip = page.getByTestId("stats-range-chip");
    for (const days of [30, 7]) {
      await chip.click();
      await page.getByTestId(`stats-range-option-${days}`).click();
      await page.getByTestId("stats-range-confirm").click();
      expect(await page.getByTestId("stats-day-row").count()).toBe(days);
      expect(await chip.evaluate(n => n === document.activeElement)).toBe(true);
    }
    const committed = await chip.textContent();
    await chip.click();
    await page.getByTestId("stats-range-option-30").click();
    await page.getByTestId("stats-range-close").click();
    expect(await chip.textContent()).toBe(committed);
    expect(await page.getByTestId("stats-day-row").count()).toBe(7);
  }, 20000);
  it("keeps overlapping cooperative leases until the last owner releases in either order", async () => {
    for (const externalFirst of [false, true]) {
      await load();
      await page.getByTestId("stats-range-chip").click();
      await page.evaluate(() => {
        const w = window as any;
        w.otherRelease = w.isolateBackground([document.querySelector("#application")]);
      });
      if (externalFirst) await page.evaluate(() => (window as any).otherRelease());
      expect(await page.locator("#application").evaluate(n => (n as HTMLElement).inert)).toBe(true);
      await page.getByTestId("stats-range-close").click();
      expect(await page.locator("#application").evaluate(n => (n as HTMLElement).inert)).toBe(!externalFirst);
      if (!externalFirst) {
        expect(await page.getByTestId("stats-range-chip").evaluate(n => n === document.activeElement)).toBe(false);
        await page.evaluate(() => { (window as any).otherRelease(); (window as any).otherRelease(); });
      }
      expect(await page.locator("#application").getAttribute("inert")).toBe(null);
    }
  }, 20000);
  it("preserves same-tick external inert writes on close and unmount without focusing through the lock", async () => {
    for (const mode of ["property", "attribute", "unmount"]) {
      await load();
      await page.getByTestId("stats-range-chip").click();
      await page.evaluate(mode => {
        const app = document.querySelector<HTMLElement>("#application")!;
        if (mode === "attribute") app.setAttribute("inert", app.getAttribute("inert")!);
        else app.inert = true;
        if (mode === "unmount") (window as any).unmountStats();
        else document.querySelector<HTMLButtonElement>('[data-testid="stats-range-close"]')!.click();
      }, mode);
      expect(await page.locator(".stats-modal-root").count()).toBe(0);
      expect(await page.locator("#application").evaluate(n => (n as HTMLElement).inert)).toBe(true);
      expect(await page.locator("#application").evaluate(n => n.contains(document.activeElement))).toBe(false);
      await page.evaluate(() => document.querySelector<HTMLElement>("#application")!.inert = false);
      expect(await page.locator("#application").getAttribute("inert")).toBe(null);
    }
  }, 20000);
  it("reasserts its lease when an external lock releases first and preserves original attribute strings", async () => {
    await load();
    await page.getByTestId("stats-range-chip").click();
    await page.evaluate(() => {
      const app = document.querySelector<HTMLElement>("#application")!;
      app.setAttribute("inert", "external-auth");
    });
    await page.evaluate(() => document.querySelector<HTMLElement>("#application")!.removeAttribute("inert"));
    expect(await page.locator("#application").evaluate(n => (n as HTMLElement).inert)).toBe(true);
    await page.getByTestId("stats-range-close").click();
    expect(await page.locator("#application").getAttribute("inert")).toBe(null);
    expect(await page.evaluate(() => {
      const node = document.createElement("div");
      node.setAttribute("inert", "original-value");
      const release = (window as any).isolateBackground([node]);
      release(); release();
      return node.getAttribute("inert");
    })).toBe("original-value");
  }, 20000);
  it("uses 14–16px computed modal top padding at 320 and 390 while keeping bottom safe area and 44px controls", async () => {
    await load();
    await page.getByTestId("stats-range-chip").click();
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const metrics = await page.getByTestId("stats-range-dialog").evaluate(n => {
        const css = getComputedStyle(n);
        return { top: parseFloat(css.paddingTop), bottom: parseFloat(css.paddingBottom), width: n.getBoundingClientRect().width,
          controls: Array.from(n.querySelectorAll("button")).map(b => b.getBoundingClientRect().height) };
      });
      expect(metrics.top).toBeGreaterThanOrEqual(14);
      expect(metrics.top).toBeLessThanOrEqual(16);
      expect(metrics.bottom).toBeGreaterThanOrEqual(16);
      expect(metrics.width).toBeLessThanOrEqual(width);
      expect(metrics.controls.every(h => h >= 44)).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
  }, 20000);
  it("opens real daily Timeline entries and cleans isolation before edit routing", async () => {
    await load();
    await page.getByTestId("stats-day-row").first().click();
    expect(
      await page.getByTestId("stats-day-dialog").locator(".entry").count(),
    ).toBe(8);
    await page
      .getByTestId("stats-day-dialog")
      .locator(".entry")
      .first()
      .click();
    expect(await page.locator(".stats-modal-root").count()).toBe(0);
    expect(
      await page
        .locator("#application")
        .evaluate((node) => (node as HTMLElement).inert),
    ).toBe(false);
    expect(await page.evaluate(() => location.hash)).toMatch(
      /^#edit\/synthetic-/,
    );
  }, 20000);
});

describe("modal isolation ownership", () => {
  it("restores each captured inert value, preserves pre-inert roots, and cleanup is idempotent", () => {
    const a = { inert: false },
      b = { inert: true };
    const release = isolateBackground([a, b]);
    expect(a.inert).toBe(true);
    expect(b.inert).toBe(true);
    release();
    expect(a.inert).toBe(false);
    expect(b.inert).toBe(true);
    a.inert = true;
    release();
    expect(a.inert).toBe(true);
  });
});
