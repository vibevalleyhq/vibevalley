import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** A new blocks artifact, started with 新建 on 产出 and named by typing over its title; its blocks once it is open. */
async function newBlocks(page: Page, title: string) {
  await page.goto("/artifacts");
  await page.getByTestId("new-artifact").click();
  const name = page.getByTestId("artifact-title");
  await expect(name).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press("Enter");
  await expect(name).toHaveValue(title);
  // Its own, by the id in the address: /artifacts first opens the newest one there was, another test's on a shared server.
  await expect(page).toHaveURL(/\/artifacts\/[^/?]+$/);
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const shown = page.locator(`[data-testid="artifact"][data-key="${id}"]`);
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
  await expect.poll(async () => (await api.artifact.list({})).some((a) => a.title === title)).toBe(true);
  const id = (await api.artifact.list({})).find((a) => a.title === title)!.id;
  expect((await api.artifact.block.list({ id })).blocks.filter((b) => b.deleted !== true).map((b) => b.text.map((s) => s.t).join(""))).toEqual(["firstsecond"]);
});
