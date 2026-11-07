import { diagnosticsOf } from "./browser";
import { expect, test } from "./stories-fixtures";

// Wide enough for two frames of a page-sized part side by side, with the tree and the arguments.
test.use({ viewport: { width: 1680, height: 1000 } });

const key = (k: string) => `[data-testid="story-link"][data-key="${k}"]`;
const folder = (path: string) => `[data-testid="story-folder"][data-key="${path}"]`;

test("regression: schema routing rejects invalid params and repeated scalar search without falling through", async ({ page }) => {
  const check = diagnosticsOf(page);
  await page.goto(`/?${new URLSearchParams({ s: "交互/路由:Schema", theme: "light", w: "400" })}`);
  await expect(page.getByTestId("typed-values")).toHaveAttribute("data-id", "1");
  await page.getByTestId("typed-update").click();
  await expect(page.getByTestId("typed-values")).toHaveAttribute("data-page", "2");
  await expect(page.getByTestId("typed-values")).toHaveAttribute("data-tags", "a,b");
  await expect(page.getByTestId("typed-location")).toHaveText("/typed/1?foreign=keep&page=2&tags=a&tags=b#anchor");
  await page.getByTestId("typed-bad-param").click();
  await expect(page.getByTestId("typed-invalid")).toBeVisible();
  await expect(page.getByTestId("typed-fallback")).toHaveCount(0);
  await page.getByTestId("typed-bad-search").click();
  await expect(page.getByTestId("typed-invalid")).toBeVisible();
  await page.getByTestId("typed-restore").click();
  await expect(page.getByTestId("typed-values")).toHaveAttribute("data-id", "2");
  check();
});

test("regression: owned queries share demand without sharing story clients or previous identities", async ({ page }) => {
  const check = diagnosticsOf(page);
  await page.goto(`/?${new URLSearchParams({ s: "交互/查询:Lifecycle", theme: "both", w: "400" })}`);
  const first = page.getByTestId("story-frame").first();
  const second = page.getByTestId("story-frame").nth(1);
  await expect(first.getByTestId("query-calls")).toHaveText("1");
  await expect(second.getByTestId("query-calls")).toHaveText("1");
  await first.getByTestId("query-resolve").click();
  await expect(first.getByTestId("query-one")).toHaveAttribute("data-current", "1");
  await expect(first.getByTestId("query-two")).toHaveAttribute("data-current", "1");
  await expect(second.getByTestId("query-one")).not.toHaveAttribute("data-current");
  await second.getByTestId("query-invalid").click();
  await expect(second.getByTestId("query-one")).toHaveAttribute("data-status", "error");
  await expect(second.getByTestId("query-one")).not.toHaveAttribute("data-current");
  await second.getByTestId("query-next").click();
  await expect(second.getByTestId("query-calls")).toHaveText("2");
  await second.getByTestId("query-resolve").click();
  await expect(second.getByTestId("query-one")).toHaveAttribute("data-current", "2");
  await expect(first.getByTestId("query-one")).toHaveAttribute("data-current", "1");
  await first.getByTestId("query-next").click();
  await expect(first.getByTestId("query-one")).not.toHaveAttribute("data-current");
  await expect(first.getByTestId("query-one")).toHaveAttribute("data-previous", "1");
  await first.getByTestId("query-unmount").click();
  await expect(first.getByTestId("query-aborts")).toHaveText("0");
  await first.getByTestId("query-toggle").click();
  await expect(first.getByTestId("query-aborts")).toHaveText("1");
  await first.getByTestId("query-resolve").click();
  await expect(first.getByTestId("query-one")).not.toHaveAttribute("data-current");
  await first.getByTestId("query-toggle").click();
  await expect(first.getByTestId("query-calls")).toHaveText("3");
  await first.getByTestId("query-resolve").click();
  await expect(first.getByTestId("query-one")).toHaveAttribute("data-current", "2");
  check();
});

test("regression: schema form keeps later edits and unknown delivery", async ({ page }) => {
  const check = diagnosticsOf(page);
  await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Form:Receipts", theme: "light", w: "400" })}`);
  const name = page.getByTestId("form-name");
  await page.getByTestId("form-submit").click();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toBeFocused();
  await expect(page.getByTestId("form-writes")).toHaveText("0");
  await name.fill("First");
  await page.getByTestId("form-submit").click();
  await expect(page.getByTestId("form-writes")).toHaveText("1");
  await name.fill("Later edit");
  await page.getByTestId("form-accepted").click();
  await expect(name).toHaveValue("Later edit");
  await expect(page.getByTestId("form-writes")).toHaveAttribute("data-dirty", "true");
  await page.getByTestId("form-submit").click();
  await page.getByTestId("form-unknown").click();
  await expect(page.getByTestId("form-demo").locator("[data-form-summary]")).toBeVisible();
  await expect(name).toHaveValue("Later edit");
  await expect(page.getByTestId("form-writes")).toHaveText("2");
  check();
});

test("owned table connects sorting, pagination, selection, hiding and filtering to the DOM", async ({ page }) => {
  const check = diagnosticsOf(page);
  await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/DataTable:Local", theme: "light", w: "400" })}`);
  const rows = page.getByTestId("table-row");
  await expect(rows).toHaveCount(25);
  await rows.first().getByTestId("table-select-row").click();
  await expect(page.getByTestId("table-select-page")).toHaveAttribute("aria-checked", "mixed");
  await page.getByTestId("table-select-page").click();
  await expect(page.getByTestId("table-selected")).toHaveText("25");
  await page.locator('[data-testid="table-sort"][data-key="count"]').click();
  await expect(rows.first()).toHaveAttribute("data-key", "999");
  await expect(page.locator('th[data-column="count"]')).toHaveAttribute("aria-sort", "ascending");
  await page.getByTestId("table-next").click();
  await expect(rows.first()).toHaveAttribute("data-key", "974");
  await page.locator('[data-testid="table-column"][data-key="count"]').click();
  await expect(page.locator('th[data-column="count"]')).toHaveCount(0);
  await page.getByTestId("table-filter").click();
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId("table-selected")).toHaveText("25");
  check();
});

test("regression: a remote table never acts on a previous query page", async ({ page }) => {
  const check = diagnosticsOf(page);
  await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/DataTable:Remote", theme: "dark", w: "400" })}`);
  await page.getByTestId("table-deliver").click();
  await expect(page.getByTestId("data-table")).toHaveAttribute("data-stale", "false");
  await expect(page.getByTestId("table-row").first()).toHaveAttribute("data-key", "0");
  await page.getByTestId("table-next").click();
  await expect(page.getByTestId("data-table")).toHaveAttribute("data-stale", "true");
  await expect(page.getByTestId("table-row").first()).toHaveAttribute("data-key", "0");
  await expect(page.getByTestId("table-select-page")).toBeDisabled();
  await expect(page.getByTestId("data-table").locator("tbody")).toHaveAttribute("inert");
  await page.getByTestId("table-deliver").click();
  await expect(page.getByTestId("data-table")).toHaveAttribute("data-stale", "false");
  await expect(page.getByTestId("table-row").first()).toHaveAttribute("data-key", "2");
  await page.getByTestId("table-select-page").click();
  await expect(page.getByTestId("table-selected")).toHaveText("2");
  check();
});

test("the viewer opens a story from the address, in folders, and keeps the view in it", async ({ page }) => {
  await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Button:Tones", theme: "dark", w: "400" })}`);
  await expect(page.locator(key("组件/工作台/Button:Tones"))).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("story-frame")).toHaveCount(1);
  await expect(page.getByTestId("story-frame")).toHaveAttribute("data-theme", "dark");

  await expect(page.locator(folder("设计体系"))).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(folder("组件/工作台"))).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(folder("组件/像素"))).toHaveAttribute("aria-expanded", "false");
  await page.locator(folder("组件/像素")).click();
  await expect(page.locator(folder("组件/像素"))).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-testid="story-link"][data-key^="组件/像素/"]').first()).toBeVisible();

  await page.getByTestId("story-theme").locator('[data-value="both"]').click();
  await expect(page.getByTestId("story-frame")).toHaveCount(2);
  await page.locator(key("组件/工作台/Button:Playground")).click();
  await expect(page).toHaveURL(new RegExp(`s=${encodeURIComponent("组件/工作台/Button:Playground")}&theme=both&w=400`, "u"));

  const label = page.locator('[data-testid="story-arg"][data-name="label"] input');
  await label.fill("go");
  await expect(page.getByTestId("story-frame").first().locator("button")).toHaveText("go");
  await page.getByTestId("story-reset").click();
  await expect(label).not.toHaveValue("go");

  await page.getByTestId("stories-search").fill("工作台 button tones");
  await expect(page.getByTestId("story-link")).toHaveCount(1);
});

test("a state grid draws every combination, and a forced state looks as the real one does", async ({ page }) => {
  await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Button:States", theme: "light", w: "full" })}`);
  const grid = page.getByTestId("story-grid");
  // Four tones down, rest / hover / focus / pressed across.
  await expect(grid.getByTestId("story-cell")).toHaveCount(16);
  const ground = (state: string) =>
    grid
      .locator(`tr:nth-child(1) [data-testid="story-cell"]${state === "rest" ? ":not([data-pseudo])" : `[data-pseudo="${state}"]`} button`)
      .evaluate((b) => getComputedStyle(b).backgroundColor);
  expect(await ground("hover")).not.toBe(await ground("rest"));
  const ring = (state: string) =>
    grid
      .locator(`tr:nth-child(1) [data-testid="story-cell"]${state === "rest" ? ":not([data-pseudo])" : `[data-pseudo="${state}"]`} button`)
      .evaluate((b) => getComputedStyle(b).outlineStyle);
  expect(await ring("focus")).not.toBe(await ring("rest"));

  // The single view takes one state for the whole frame.
  await page.getByTestId("story-mode").locator('[data-value="single"]').click();
  await page.getByTestId("story-state").locator('[data-value="hover"]').click();
  await expect(page.getByTestId("story-frame")).toHaveAttribute("data-pseudo", "hover");
  await expect(page).toHaveURL(/view=single&state=hover/u);

  await expect(page.getByTestId("story-a11y")).toHaveAttribute("data-count", "0");
  await page.getByTestId("story-a11y").click();
  await expect(page.getByTestId("story-a11y-panel")).toBeVisible();
});

test("the language comes from the address, before the parts draw", async ({ page }) => {
  await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/ConfirmButton:Delete", theme: "light", lang: "en" })}`);
  await expect(page.locator("html")).toHaveAttribute("data-locale", "en");
  await expect(page.getByTestId("story-lang").locator('[data-value="en"]')).toHaveAttribute("aria-checked", "true");
});

test("regression: route instances survive parameter changes and links retain native behavior", async ({ page }) => {
  const diagnostics: string[] = [];
  page.on("console", (message) => {
    if (/\[(STRICT_|REACTIVITY_|NO_OWNER_|REACTIVE_WRITE_)/u.test(message.text())) diagnostics.push(message.text());
  });
  await page.goto(`/?${new URLSearchParams({ s: "交互/路由:Navigation", theme: "light", w: "full" })}`);
  const detail = page.getByTestId("router-detail");
  const layout = page.getByTestId("router-layout");
  const originalDetail = await detail.elementHandle();
  const originalLayout = await layout.elementHandle();
  await page.getByTestId("router-two").click();
  await expect(detail).toHaveAttribute("data-key", "two");
  expect(await detail.evaluate((current, original) => current === original, originalDetail)).toBe(true);
  await expect(page.getByTestId("router-two")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("router-prevent").click();
  await expect(page.getByTestId("router-prevented")).toHaveText("1");
  await expect(detail).toHaveAttribute("data-key", "two");
  await page.getByTestId("router-replace").click();
  await expect(detail).toHaveAttribute("data-key", "replaced");
  await page.getByTestId("router-back").click();
  await expect(detail).toHaveAttribute("data-key", "one");
  await page.getByTestId("router-forward").click();
  await expect(detail).toHaveAttribute("data-key", "replaced");
  await page.getByTestId("router-anchor").click();
  await page.getByTestId("router-search").click();
  await expect(page.getByTestId("router-location")).toHaveText("/demo/replaced?repo=one&tag=a&tag=b#router-bottom");
  await page.getByTestId("router-other").click();
  await expect(page.getByTestId("router-other-page")).toBeVisible();
  expect(await layout.evaluate((current, original) => current === original, originalLayout)).toBe(true);
  expect(await originalDetail?.evaluate((element) => element.isConnected)).toBe(false);
  const popup = page.waitForEvent("popup");
  await page.getByTestId("router-new").click();
  await (await popup).close();
  await expect(page.getByTestId("router-other-page")).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.getByTestId("router-download").click();
  await (await downloaded).cancel();
  await expect(page.getByTestId("router-other-page")).toBeVisible();
  expect(diagnostics).toEqual([]);
});

test("regression: runtime model columns use model ids for sorting and visibility", async ({ page }) => {
  const check = diagnosticsOf(page);
  await page.goto(`/?${new URLSearchParams({ s: "界面/农机/详情:能用", theme: "light", w: "400" })}`);
  const table = page.getByTestId("runtime-models");
  await expect(table.getByTestId("table-row")).toHaveCount(2);
  await table.locator('[data-testid="table-sort"][data-key="name"]').click();
  await table.locator('[data-testid="table-sort"][data-key="name"]').click();
  await expect(table.getByTestId("table-row").first()).toHaveAttribute("data-key", "sonnet");
  await expect(table.locator('th[data-column="name"]')).toHaveAttribute("aria-sort", "descending");
  await table.locator('[data-testid="table-column"][data-key="effort"]').click();
  await expect(table.locator('th[data-column="effort"]')).toHaveCount(0);
  check();
});
