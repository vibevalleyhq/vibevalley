import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** A new blocks artifact, started on 产出 with a title; its blocks once it is open. */
async function newBlocks(page: Page, title: string) {
  await page.goto("/artifacts");
  await page.getByTestId("new-artifact-title").fill(title);
  await page.getByTestId("new-artifact").click();
  // Its own, by its title: /artifacts first opens the newest one there was, another test's on a shared server.
  const shown = page.locator('[data-testid="artifact"]', { has: page.getByRole("heading", { name: title }) });
  await expect(shown).toHaveAttribute("data-body", "blocks");
  return shown.getByTestId("artifact-blocks");
}

test("a blocks artifact is started on the page and written block by block, and what is written is kept", async ({ page }) => {
  const title = `weekly ${Date.now() % 100000}`;
  const doc = await newBlocks(page, title);
  await expect(doc).toBeVisible();
  await doc.getByTestId("artifact-append").click();
  // Markdown's shortcuts: "# " makes a heading, "- " a bulleted line.
  await page.keyboard.type("# This week");
  await page.keyboard.type(" done");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- board");
  await page.keyboard.press("Enter");
  await page.keyboard.type("chat");
  await page.keyboard.press("Tab");
  await expect(doc).toHaveAttribute("data-state", "saved", { timeout: 10_000 });
  await expect(doc).toHaveAttribute("data-blocks", "3");
  await page.reload();
  await expect(doc.locator('[data-type="heading"]')).toContainText("This week done");
  await expect(doc.locator('[data-type="bulleted"]')).toHaveCount(2);
  await expect(doc.locator('[data-type="bulleted"]').nth(1)).toContainText("chat");
});

test("Backspace at a block's start joins it to the one before", async ({ page, api }) => {
  const title = `join ${Date.now() % 100000}`;
  const doc = await newBlocks(page, title);
  await doc.getByTestId("artifact-append").click();
  await page.keyboard.type("first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Tab");
  await expect(doc).toHaveAttribute("data-blocks", "1", { timeout: 10_000 });
  await expect(doc).toHaveAttribute("data-state", "saved");
  const id = (await api.artifact.list({})).find((a) => a.title === title)!.id;
  expect((await api.artifact.blocks.get({ id })).blocks.filter((b) => !b.deleted).map((b) => b.text.map((s) => s.t).join(""))).toEqual(["firstsecond"]);
});
