import type { Page } from "@playwright/test";

import { pathOf } from "@vibevalley/protocol";

import { diagnosticsOf } from "./browser";
import { expect, gate, settled, test } from "./fixtures";

test.use({ farm: "pkm-dates", timezoneId: "Asia/Shanghai" });

async function startOn(page: Page, at: string) {
  const time = new Date(at);
  // The clock runs until the opening cover is gone (its progress runs on timers), then stops just before the day under test ends.
  await page.clock.install({ time: new Date(time.getTime() - 10_000) });
  await page.goto("/pkm");
  await expect(page.locator("#opening")).toHaveCount(0);
  await page.clock.pauseAt(time);
}

for (const [before, after] of [
  ["2026-11-17", "2026-11-18"],
  ["2026-11-30", "2026-12-01"],
  ["2026-12-31", "2027-01-01"],
] as const) {
  test(`regression: the same PKM page rolls from ${before} to ${after}`, async ({ page }, info) => {
    const check = diagnosticsOf(page);
    await startOn(page, `${before}T23:59:59+08:00`);
    const calendar = page.getByTestId("pkm-calendar");
    const user = await calendar.elementHandle();
    const journals = page.getByTestId("pkm-day");
    const oldSlug = before.replaceAll("-", "_");
    const newSlug = after.replaceAll("-", "_");
    await expect(calendar.locator("[data-today]")).toHaveAttribute("data-key", before);
    await expect(journals.first()).toHaveAttribute("data-key", oldSlug);
    await expect(calendar.locator(`[data-key="${before}"]`)).toHaveAttribute("data-journal", "");
    await page.clock.runFor(2000);
    await expect(calendar.locator("[data-today]")).toHaveAttribute("data-key", after);
    await expect(calendar.locator(`[data-key="${before}"]`)).not.toHaveAttribute("data-today", "");
    await expect(calendar.getByTestId("pkm-calendar-month")).toHaveAttribute("data-year", after.slice(0, 4));
    await expect(calendar.getByTestId("pkm-calendar-month")).toHaveAttribute("data-month", String(Number(after.slice(5, 7))));
    await expect(journals.first()).toHaveAttribute("data-key", newSlug);
    await expect(journals.nth(1)).toHaveAttribute("data-key", oldSlug);
    await expect(journals.filter({ has: page.locator(`[data-testid="pkm-block"]`) }).first()).toHaveAttribute("data-key", newSlug);
    expect(await calendar.evaluate((current, original) => current === original, user)).toBe(true);
    const current = calendar.locator("[data-today]");
    await expect(current).toHaveAttribute("data-journal", "");
    const accent = await current.locator('[aria-hidden="true"]').evaluate((element) => getComputedStyle(element).backgroundColor);
    await expect(current).toHaveCSS("box-shadow", `${accent} 0px 0px 0px 1px`);
    await expect(calendar.locator(`[data-key="${before}"]`)).toHaveCSS("box-shadow", "none");
    if (before === "2026-12-31") {
      await page.clock.resume();
      await settled(page);
      await page.screenshot({ path: info.outputPath("pkm-new-year-shanghai.png"), fullPage: true });
    }
    check();
  });
}

test("regression: an explicitly chosen calendar month survives the year boundary", async ({ page }) => {
  const check = diagnosticsOf(page);
  await startOn(page, "2026-12-31T23:59:59+08:00");
  const calendar = page.getByTestId("pkm-calendar");
  const month = calendar.getByTestId("pkm-calendar-month");
  await expect(page.getByTestId("pkm-day").first()).toHaveAttribute("data-key", "2026_12_31");
  await calendar.getByTestId("pkm-calendar-previous").click();
  await expect(month).toHaveAttribute("data-month", "11");
  await calendar.getByTestId("pkm-calendar-next").click();
  await expect(month).toHaveAttribute("data-month", "12");
  await page.clock.runFor(2000);
  await expect(page.getByTestId("pkm-day").first()).toHaveAttribute("data-key", "2027_01_01");
  await expect(month).toHaveAttribute("data-year", "2026");
  await expect(month).toHaveAttribute("data-month", "12");
  await expect(calendar.locator("[data-today]")).toHaveAttribute("data-key", "2027-01-01");
  check();
});

test("regression: returning from a hidden page catches up after several local days", async ({ page }) => {
  const check = diagnosticsOf(page);
  await startOn(page, "2027-01-29T12:00:00+08:00");
  const journals = page.getByTestId("pkm-day");
  const calendar = page.getByTestId("pkm-calendar");
  await expect(journals.first()).toHaveAttribute("data-key", "2027_01_29");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.setSystemTime(new Date("2027-02-02T12:00:00+08:00"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(journals.first()).toHaveAttribute("data-key", "2027_01_29");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(journals.first()).toHaveAttribute("data-key", "2027_02_02");
  await expect(journals.nth(1)).toHaveAttribute("data-key", "2027_01_29");
  await expect(calendar.locator("[data-today]")).toHaveAttribute("data-key", "2027-02-02");
  await expect(calendar.getByTestId("pkm-calendar-month")).toHaveAttribute("data-month", "2");
  check();
});

test("regression: an earlier day's delayed journal response cannot replace today's journal", async ({ page }) => {
  const check = diagnosticsOf(page);
  const entered = gate();
  const release = gate();
  let first = true;
  await page.route(`**${pathOf("pkm.journal.open")}`, async (route) => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    entered.open();
    await release.opened;
    await route.fulfill({ response });
  });
  try {
    await startOn(page, "2027-03-30T23:59:59+08:00");
    await entered.opened;
    await page.clock.runFor(2000);
    await expect(page.getByTestId("pkm-day").first()).toHaveAttribute("data-key", "2027_03_31");
    await expect(page.getByTestId("pkm-days")).toHaveAttribute("aria-busy", "true");
    release.open();
    await expect(page.getByTestId("pkm-days")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByTestId("pkm-day").first()).toHaveAttribute("data-key", "2027_03_31");
    await expect(page.getByTestId("pkm-day").nth(1)).toHaveAttribute("data-key", "2027_03_30");
    check();
  } finally {
    release.open();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("regression: leaving PKM stops journal opens and remounting reads the current day once", async ({ page }) => {
  const check = diagnosticsOf(page);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === pathOf("pkm.journal.open")) requests.push(request.url());
  });
  await startOn(page, "2027-04-30T23:59:59+08:00");
  await expect(page.getByTestId("pkm-day").first()).toHaveAttribute("data-key", "2027_04_30");
  await page.getByTestId("rail").locator('[data-place="issues"]').click();
  await expect(page.getByTestId("pkm-days")).toHaveCount(0);
  await expect(page.getByTestId("pkm-calendar")).toHaveCount(0);
  await page.clock.setSystemTime(new Date("2027-05-03T23:59:59+08:00"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(requests).toHaveLength(1);
  await page.goBack();
  await expect(page.getByTestId("pkm-day").first()).toHaveAttribute("data-key", "2027_05_03");
  await expect(page.getByTestId("pkm-days")).toHaveAttribute("aria-busy", "false");
  expect(requests).toHaveLength(2);
  await page.clock.runFor(2000);
  await expect(page.getByTestId("pkm-day").first()).toHaveAttribute("data-key", "2027_05_04");
  await expect(page.getByTestId("pkm-day").nth(1)).toHaveAttribute("data-key", "2027_05_03");
  await expect(page.getByTestId("pkm-days")).toHaveAttribute("aria-busy", "false");
  expect(requests).toHaveLength(3);
  check();
});
