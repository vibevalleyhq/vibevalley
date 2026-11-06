import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./fixtures";

const outline = "- first thought\n- second thought\n  - under it\n- third thought\n";

test("a page is written in place: Enter starts a block, Tab nests it, and the server gets them in order", async ({ page, api }) => {
  await api.pkm.page.save({ title: "Garden", tier: "repo", props: { status: "active", deadline: "2099-01-01" }, markdown: outline });
  await page.goto("/pkm/garden");
  const blocks = page.getByTestId("pkm-block");
  await expect(blocks).toHaveCount(4);
  await expect(page.getByTestId("pkm-prop").and(page.locator('[data-key="status"]'))).toBeVisible();

  await blocks.first().getByTestId("pkm-block-text").click();
  const editor = page.getByTestId("pkm-editor");
  await expect(editor).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" here");
  await page.keyboard.press("Enter");
  await expect(blocks).toHaveCount(5);
  await expect(editor).toBeFocused();
  await page.keyboard.type("a new one [[Gar");
  const complete = page.getByTestId("pkm-complete");
  await expect(complete.locator('[role="option"][data-key="garden"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(editor).toHaveValue("a new one [[Garden]]");
  await page.keyboard.press("Tab");
  await expect(editor).toBeFocused();
  await expect(blocks.nth(1)).toHaveAttribute("data-key", /.+/u);
  await page.keyboard.press("Escape");

  await expect
    .poll(async () => (await api.pkm.page.get({ page: "garden" })).page.blocks.map((b) => [b.depth, b.body]))
    .toEqual([
      [0, "first thought here"],
      [1, "a new one [[Garden]]"],
      [0, "second thought"],
      [1, "under it"],
      [0, "third thought"],
    ]);
});

test("a Chinese input method's 【【 opens a link, ＃ after Chinese a tag, and pinyin finds the page", async ({ page, api }) => {
  await api.pkm.page.save({ title: "Herbs", tier: "repo", markdown: "- first thought\n" });
  await api.pkm.page.save({ title: "读书", tier: "area", markdown: "- 书单\n" });
  await page.goto("/pkm/herbs");
  const blocks = page.getByTestId("pkm-block");
  await blocks.first().getByTestId("pkm-block-text").click();
  const editor = page.getByTestId("pkm-editor");
  await page.keyboard.press("End");
  // What an input method commits: each mark as one input, not a composition.
  for (const typed of ["，见", "【", "【", "Her"]) await page.keyboard.insertText(typed);
  await expect(editor).toHaveValue("first thought，见[[Her");
  const complete = page.getByTestId("pkm-complete");
  await complete.locator('[role="option"][data-key="herbs"]').click();
  await expect(editor).toHaveValue("first thought，见[[Herbs]]");
  for (const typed of ["读了", "＃", "ds"]) await page.keyboard.insertText(typed);
  await complete.locator('[role="option"][data-key="读书"]').click();
  await expect(editor).toHaveValue("first thought，见[[Herbs]]读了#读书 ");
  await page.keyboard.press("Escape");
  await expect(blocks.first().getByTestId("pkm-link")).toHaveCount(2);
  await expect
    .poll(async () => (await api.pkm.page.get({ page: "herbs" })).page.blocks.map((b) => b.body.trim()))
    .toEqual(["first thought，见[[Herbs]]读了#读书"]);
});

test("the search lists pages and blocks by page and opens one at its block", async ({ page, api }) => {
  await api.pkm.page.save({ title: "Orchard", tier: "resource", markdown: "- apples ripen in autumn\n- pears too\n" });
  await page.goto("/pkm/orchard");
  await page.getByTestId("pkm-find").click();
  await page.getByTestId("pkm-search-input").fill("pears");
  const row = page.getByTestId("pkm-search-row").filter({ hasText: "pears too" });
  await expect(row).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await row.click();
  await expect(page).toHaveURL(/\/pkm\/orchard\?b=/u);
  await expect(page.locator('[data-testid="pkm-block"][data-lit]')).toContainText("pears too");
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
});

test("/pkm opens on today's journal to write in, and the calendar opens a day", async ({ page }) => {
  await page.goto("/pkm");
  const today = page.getByTestId("pkm-day").first();
  await expect(today.getByTestId("pkm-block")).toHaveCount(1);
  const calendar = page.getByTestId("pkm-calendar");
  await expect(calendar.locator("[data-journal]")).toHaveCount(1);
  await calendar.getByTestId("pkm-calendar-previous").click();
  await calendar.locator('[data-testid="pkm-day-cell"]').nth(10).click();
  await expect(page).toHaveURL(/\/pkm\/\d{4}_\d{2}_\d{2}$/u);
  await expect(page.getByTestId("pkm-title")).not.toHaveText(/_/u);
});

test("Ctrl+K finds a note page by its title and hands the words to the notes' search", async ({ page, api }) => {
  await api.pkm.page.save({ title: "Beehives", tier: "area", markdown: "- check the queens\n" });
  await page.goto("/pkm");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("switcher-input").fill("beehi");
  await page.locator('[data-kind="note"][data-key="beehives"]').click();
  await expect(page).toHaveURL(/\/pkm\/beehives$/u);
  await expect(page.getByTestId("pkm-title")).toHaveText("Beehives");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("switcher-input").fill("queens");
  await page.locator('[data-kind="notes"]').click();
  await expect(page.getByTestId("pkm-search-input")).toHaveValue("queens");
  await expect(page.getByTestId("pkm-search-row")).toContainText("check the queens");
});

test("blocks picked with Esc and Shift+↓ move together, and a fold is kept in the page's file", async ({ page, api }) => {
  await api.pkm.page.save({ title: "Orchard rows", tier: "resource", markdown: "- a\n- b\n- c\n- d\n" });
  await page.goto("/pkm/orchard-rows");
  const blocks = page.getByTestId("pkm-block");
  const outline = page.getByTestId("pkm-outline");
  const shape = async () => (await api.pkm.page.get({ page: "orchard-rows" })).page.blocks.map((b) => [b.depth, b.body, b.props.collapsed === "true"]);
  await blocks.nth(1).getByTestId("pkm-block-text").click();
  await page.keyboard.press("Escape");
  await expect(outline).toBeFocused();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(outline).toHaveAttribute("data-picked", "2");
  await page.keyboard.press("Tab");
  await expect.poll(shape).toEqual([
    [0, "a", false],
    [1, "b", false],
    [1, "c", false],
    [0, "d", false],
  ]);

  await page.keyboard.press("Escape");
  await blocks.first().locator("button[aria-expanded]").click();
  await expect(blocks).toHaveCount(2);
  await expect.poll(async () => (await shape())[0]).toEqual([0, "a", true]);
  await page.reload();
  await expect(blocks).toHaveCount(2);
  await blocks.first().locator("button[aria-expanded]").click();
  await expect(blocks).toHaveCount(4);

  await blocks.nth(1).getByTestId("pkm-block-text").click();
  await blocks
    .nth(2)
    .getByTestId("pkm-block-text")
    .click({ modifiers: ["Shift"] });
  await expect(outline).toHaveAttribute("data-picked", "2");
  await page.keyboard.press("Backspace");
  await expect.poll(shape).toEqual([
    [0, "a", false],
    [0, "d", false],
  ]);
});

test("a block dragged by its bullet goes where it is dropped: above a row, or inside it", async ({ page, api }) => {
  await api.pkm.page.save({ title: "Pot benches", tier: "resource", markdown: "- a\n- b\n- c\n" });
  await page.goto("/pkm/pot-benches");
  const blocks = page.getByTestId("pkm-block");
  const bodies = async () => (await api.pkm.page.get({ page: "pot-benches" })).page.blocks.map((b) => `${b.depth}${b.body}`);
  await blocks
    .nth(2)
    .getByTestId("pkm-bullet")
    .dragTo(blocks.first(), { targetPosition: { x: 40, y: 2 } });
  await expect.poll(bodies).toEqual(["0c", "0a", "0b"]);
  const b = blocks.nth(2);
  const box = (await b.boundingBox())!;
  await blocks
    .first()
    .getByTestId("pkm-bullet")
    .dragTo(b, { targetPosition: { x: Math.min(box.width - 4, 120), y: box.height - 3 } });
  await expect.poll(bodies).toEqual(["0a", "0b", "1c"]);
});

test("the outline's faint next line writes on at the end, in the last block while it is still empty", async ({ page, api }) => {
  await api.pkm.page.save({ title: "Hedges", tier: "resource", markdown: "- trim in March\n" });
  await page.goto("/pkm/hedges");
  const blocks = page.getByTestId("pkm-block");
  const next = page.getByTestId("pkm-append");
  await next.click();
  await expect(blocks).toHaveCount(2);
  await expect(page.getByTestId("pkm-editor")).toBeFocused();
  await page.keyboard.press("Escape");
  await next.click();
  await expect(blocks).toHaveCount(2);
  await page.keyboard.type("and in August");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await api.pkm.page.get({ page: "hedges" })).page.blocks.map((b) => b.body)).toEqual(["trim in March", "and in August"]);
});
