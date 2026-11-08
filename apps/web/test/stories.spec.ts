import { diagnosticsOf } from "./browser";
import { expect, test } from "./stories-fixtures";

// Wide enough for two frames of a page-sized part side by side, with the tree and the arguments.
test.use({ viewport: { width: 1680, height: 1000 } });

const key = (k: string) => `[data-testid="story-link"][data-key="${k}"]`;
const folder = (path: string) => `[data-testid="story-folder"][data-key="${path}"]`;

test("regression: icon buttons retain keyboard selection and disabled styling", async ({ page }) => {
  const check = diagnosticsOf(page);
  for (const theme of ["light", "dark"]) {
    await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/IconButton:Playground", theme, w: "400" })}`);
    const button = page.getByTestId("icon-button-control");
    await button.focus();
    await page.keyboard.press("Space");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await page.locator('[data-testid="story-arg"][data-name="disabled"]').getByRole("checkbox").check();
    await expect(button).toBeDisabled();
    await expect(button).toHaveCSS("opacity", "0.5");
    check();
  }
});

test("regression: markdown styling preserves rendered nodes and link behavior", async ({ page }) => {
  const check = diagnosticsOf(page);
  for (const theme of ["light", "dark"]) {
    await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Markdown:Composition", theme, w: "400" })}`);
    const wrapper = page.getByTestId("markdown-composition");
    const markdown = wrapper.locator(":scope > div");
    const link = wrapper.getByRole("link");
    const original = await link.elementHandle();
    await expect(markdown).toHaveCSS("max-width", "240px");
    await expect(link).toHaveCSS("text-decoration-line", "underline");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noreferrer noopener");
    await page.getByTestId("resize-markdown").click();
    await expect(markdown).toHaveCSS("max-width", "320px");
    expect(await link.evaluate((current, before) => current === before, original)).toBe(true);
    check();
  }
});

test("regression: icon composition preserves semantic tones and object style variables", async ({ page }) => {
  const check = diagnosticsOf(page);
  for (const theme of ["light", "dark"]) {
    await page.goto(`/?${new URLSearchParams({ s: "设计体系/图标:Composition", theme, w: "400" })}`);
    const icons = page.getByTestId("story-frame").getByRole("img");
    await expect(icons).toHaveCount(3);
    const tone = await icons.nth(0).evaluate((element) => getComputedStyle(element).color);
    await expect(icons.nth(1)).toHaveCSS("color", tone);
    await expect(icons.nth(2)).not.toHaveCSS("color", tone);
    await expect(icons.nth(1)).toHaveCSS("margin-left", "12px");
    await page.getByTestId("move-icons").click();
    await expect(icons.nth(1)).toHaveCSS("margin-left", "28px");
    await expect(icons.nth(2)).toHaveCSS("margin-left", "28px");
    await expect(icons.nth(1)).toHaveCSS("color", tone);
    check();
  }
});

test("regression: text controls retain object styles, dynamic variables and input identity", async ({ page }) => {
  const check = diagnosticsOf(page);
  for (const theme of ["light", "dark"]) {
    await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Field:Dynamic controls", theme, w: "400" })}`);
    const input = page.getByTestId("dynamic-input");
    const textarea = page.getByTestId("dynamic-textarea");
    const original = await input.elementHandle();
    await expect(input).toHaveCSS("max-width", "240px");
    await expect(textarea).toHaveCSS("max-width", "240px");
    await expect(input).toHaveCSS("height", "48px");
    await expect(textarea).toHaveCSS("height", "80px");
    await input.fill("changed");
    await expect(textarea).toHaveValue("changed");
    await page.getByTestId("resize-controls").dispatchEvent("click");
    await expect(input).toHaveCSS("max-width", "320px");
    await expect(textarea).toHaveCSS("max-width", "320px");
    await expect(input).toBeFocused();
    expect(await input.evaluate((current, before) => current === before, original)).toBe(true);
    await page.keyboard.press("Tab");
    await expect(textarea).toBeFocused();
    await textarea.fill("edited");
    await expect(input).toHaveValue("edited");
    check();
  }
});

test("regression: migrated popups disable their animations for reduced motion", async ({ page }) => {
  const check = diagnosticsOf(page);
  for (const [story, kind, animation] of [
    ["Field:Select", "select", "pop-in"],
    ["MoreMenu:A place's other actions", "menu", "pop-in"],
    ["Tip:Hover", "tooltip", "fade-in"],
  ] as const) {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/?${new URLSearchParams({ s: `组件/工作台/${story}`, theme: "light", w: "400" })}`);
    const frame = page.getByTestId("story-frame");
    switch (kind) {
      case "select":
        await frame.getByRole("combobox").click();
        break;
      case "menu":
        await frame.locator('button[aria-haspopup="menu"]').click();
        break;
      case "tooltip":
        await frame.locator('span[tabindex="0"]').first().focus();
        break;
    }
    const popup = page.getByRole(kind === "select" ? "listbox" : kind);
    await expect(popup).toBeVisible();
    await expect(popup).toHaveCSS("animation-name", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(popup).toHaveCSS("animation-name", animation);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(popup).toHaveCSS("animation-name", "none");
    check();
  }
});

test("regression: segmented StyleX geometry follows selection and block resizing", async ({ page }) => {
  const check = diagnosticsOf(page);
  for (const theme of ["light", "dark"]) {
    await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Segmented:Playground", theme, w: "400" })}`);
    const frame = page.getByTestId("story-frame");
    const board = frame.locator('button[data-key="board"]');
    const thumb = frame.getByRole("group").locator('span[aria-hidden="true"]');
    await expect(frame.locator('button[data-key="farm"]')).toBeDisabled();
    await board.click();
    await expect(board).toHaveAttribute("aria-pressed", "true");
    const distance = async () => {
      const a = await thumb.boundingBox();
      const b = await board.boundingBox();
      if (a === null || b === null) throw new Error("Missing segmented geometry");
      return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
    };
    await expect.poll(distance).toBeLessThan(0.5);
    await page.locator('[data-testid="story-arg"][data-name="block"]').getByRole("checkbox").check();
    await expect.poll(distance).toBeLessThan(0.5);
    await board.focus();
    await page.keyboard.press("ArrowRight");
    await expect(frame.locator('button[data-key="list"]')).toBeFocused();
    check();
  }
});

test("regression: styled selects retain choices, disabled items and keyboard focus", async ({ page }) => {
  const check = diagnosticsOf(page);
  for (const theme of ["light", "dark"]) {
    await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Field:Select", theme, w: "400" })}`);
    const trigger = page.getByTestId("story-frame").getByRole("combobox");
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    const popup = page.getByRole("listbox");
    await expect(popup).toBeVisible();
    await expect(popup.locator('[data-key="pi"]')).toHaveAttribute("aria-disabled", "true");
    await popup.locator('[data-key="claude"]').click();
    await expect(trigger).toHaveAttribute("data-value", "claude");
    await expect(popup).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(popup).toBeVisible();
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("data-value", "");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(trigger).toBeFocused();
    check();
  }
});

test("regression: styled tabs retain keyboard selection, navigation and dynamic list styles", async ({ page }) => {
  const check = diagnosticsOf(page);
  for (const theme of ["light", "dark"]) {
    await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Tabs:Playground", theme, w: "400" })}`);
    const frame = page.getByTestId("story-frame");
    const chat = frame.locator('[role="tab"][data-key="chat"]');
    const issues = frame.locator('[role="tab"][data-key="issues"]');
    await chat.focus();
    await page.keyboard.press("ArrowRight");
    await expect(issues).toBeFocused();
    await expect(chat).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(issues).toHaveAttribute("aria-selected", "true");
    await expect(issues).toHaveCSS("font-weight", "600");
    await expect(chat).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("Home");
    await expect(chat).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(chat).toHaveAttribute("aria-selected", "true");

    await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Tabs:Links", theme, w: "400" })}`);
    await expect(issues).toHaveAttribute("href", "/tabs/issues");
    await chat.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(frame.getByTestId("tabs-location")).toHaveText("/tabs/issues");
    await expect(issues).toHaveAttribute("aria-selected", "true");
    await chat.click();
    await expect(frame.getByTestId("tabs-location")).toHaveText("/tabs/chat");
    await expect(chat).toHaveAttribute("aria-selected", "true");

    await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Tabs:Sizing", theme, w: "400" })}`);
    await expect(frame.getByRole("tablist")).toHaveCSS("width", "200px");
    await frame.getByTestId("tabs-resize").click();
    await expect(frame.getByRole("tablist")).toHaveCSS("width", "280px");
    check();
  }
});

test("regression: StyleX variables survive Base UI positioning and reactive variants", async ({ page }) => {
  const check = diagnosticsOf(page);
  for (const theme of ["light", "dark"]) {
    await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Positioner:Dynamic", theme, w: "400" })}`);
    const trigger = page.getByTestId("stylex-trigger");
    await expect(trigger).toHaveAttribute("data-ref-forwarded", "true");
    const before = await trigger.evaluate((element) => getComputedStyle(element).backgroundColor);
    await expect(page.getByTestId("story-frame")).toHaveCSS("background-color", before);
    await expect(page.getByTestId("story-frame")).toHaveCSS("width", "400px");
    await trigger.focus();
    await page.keyboard.press("Enter");
    const positioner = page.getByTestId("stylex-positioner");
    await expect(positioner).toHaveCSS("position", "fixed");
    await expect(positioner).toHaveCSS("z-index", "30");
    await expect(positioner).toHaveCSS("width", "200px");
    await expect(page.getByTestId("stylex-resize")).toBeFocused();
    const anchor = await trigger.boundingBox();
    const popup = await positioner.boundingBox();
    if (!anchor || !popup) throw new Error("Missing positioned geometry");
    expect(Math.abs(popup.y - anchor.y - anchor.height - 6)).toBeLessThan(1);
    await page.getByTestId("stylex-resize").click();
    await expect(positioner).toHaveCSS("width", "280px");
    await expect(trigger).not.toHaveCSS("background-color", before);
    await page.keyboard.press("Escape");
    await expect(positioner).toHaveCount(0);
    await expect(trigger).toBeFocused();
    const branch = page.locator(folder("组件"));
    if ((await branch.getAttribute("aria-expanded")) === "false") await branch.click();
    await expect(branch).toHaveAttribute("aria-expanded", "true");
    const icon = branch.locator('span[aria-hidden="true"]').first();
    await expect(icon).toHaveCSS("display", "flex");
    await expect(icon).toHaveCSS("flex-shrink", "0");
    await expect(icon).toHaveCSS("rotate", "90deg");
    await branch.click();
    await expect(branch).toHaveAttribute("aria-expanded", "false");
    await expect(icon).toHaveCSS("rotate", "none");
    check();
  }
});

test("regression: split layouts retain breakpoint borders, bare cards and selected hover", async ({ page }) => {
  const check = diagnosticsOf(page);
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/layout:Split boundaries", theme, w: "800" })}`);
    const split = page.getByTestId("split-boundaries").locator(":scope > div");
    const list = split.locator(":scope > div").first();
    const card = page.getByTestId("split-list");
    await expect(split).toHaveCSS("flex-direction", "row");
    await expect(list).toHaveCSS("width", "280px");
    await expect(list).toHaveCSS("border-right-width", "1px");
    await expect(list).toHaveCSS("border-bottom-width", "0px");
    await expect(card).toHaveCSS("border-top-width", "0px");
    await expect(card.locator("header")).toHaveCSS("height", "32px");
    const selected = card.getByTestId("list-row").first();
    const other = card.getByTestId("list-row").nth(1);
    await expect(selected).toHaveAttribute("aria-current", "page");
    const resting = await selected.evaluate((element) => getComputedStyle(element).backgroundColor);
    await selected.hover();
    const hovered = await selected.evaluate((element) => getComputedStyle(element).backgroundColor);
    await other.hover();
    await expect(other).toHaveCSS("background-color", hovered);
    await expect(selected).toHaveCSS("background-color", resting);
    await page.setViewportSize({ width: 767, height: 900 });
    await expect(split).toHaveCSS("flex-direction", "column");
    await expect(list).toHaveCSS("border-right-width", "0px");
    await expect(list).toHaveCSS("border-bottom-width", "1px");
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(split).toHaveCSS("flex-direction", "row");
    await page.setViewportSize({ width: 900, height: 900 });
    await page.getByTestId("story-arg").and(page.locator('[data-name="edge"]')).getByRole("checkbox").uncheck();
    await expect(split).toHaveCSS("gap", "12px");
    await expect(card).toHaveCSS("border-top-width", "1px");
    await expect(card.locator("header")).toHaveCSS("height", "40px");
    check();
  }
});

test("regression: card styles preserve reactive dimensions and action focus", async ({ page }) => {
  const check = diagnosticsOf(page);
  for (const theme of ["light", "dark"]) {
    await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/layout:Dynamic card", theme, w: "400" })}`);
    const card = page.getByTestId("styled-card");
    await expect(card).toHaveCSS("width", "240px");
    await expect(card).toHaveCSS("max-width", "240px");
    await expect(card).toHaveCSS("border-top-width", "1px");
    const action = page.getByTestId("card-resize");
    await action.focus();
    await page.keyboard.press("Enter");
    await expect(card).toHaveCSS("width", "320px");
    await expect(card).toHaveCSS("max-width", "320px");
    await expect(action).toBeFocused();
    check();
  }
});

test("regression: button style variables compose with forwarded native attributes", async ({ page }) => {
  const check = diagnosticsOf(page);
  for (const theme of ["light", "dark"]) {
    await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Button:Dynamic styles", theme, w: "400" })}`);
    const button = page.getByTestId("button-style-vars");
    await expect(button).toHaveCSS("width", "200px");
    await expect(button).toHaveCSS("max-width", "200px");
    await expect(button).toHaveCSS("margin-left", "12px");
    await expect(page.getByTestId("button-native-style")).toHaveCSS("margin-left", "12px");
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toHaveCSS("width", "280px");
    await expect(button).toHaveCSS("max-width", "280px");
    await expect(button).toBeFocused();
    check();
  }
});

test("regression: viewer rows retain indentation and selected hover precedence", async ({ page }) => {
  const check = diagnosticsOf(page);
  const key = "组件/工作台/Positioner:Dynamic";
  for (const theme of ["light", "dark"]) {
    await page.goto(`/?${new URLSearchParams({ s: key, theme, w: "400" })}`);
    await expect(page.locator(folder("组件"))).toHaveCSS("padding-left", "4px");
    const link = page.locator(`[data-testid="story-link"][data-key="${key}"]`);
    await expect(link).toHaveCSS("padding-left", "44px");
    const selected = await link.evaluate((element) => getComputedStyle(element).backgroundColor);
    await link.hover();
    await expect(link).toHaveCSS("background-color", selected);
    check();
  }
});

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
