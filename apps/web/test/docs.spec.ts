import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function newDoc(page: Page, title: string) {
  await page.goto("/docs");
  await page.getByTestId("new-doc-title").fill(title);
  await page.getByTestId("new-doc").click();
  return page.locator('[data-testid="doc"]', { has: page.getByRole("heading", { name: title }) });
}

test("a document is made and written block by block, and what is written is kept", async ({ page }) => {
  const title = `weekly ${Date.now() % 100000}`;
  const doc = await newDoc(page, title);
  await expect(doc).toBeVisible();
  await doc.getByTestId("doc-append").click();
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
  const doc = await newDoc(page, title);
  await doc.getByTestId("doc-append").click();
  await page.keyboard.type("first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Tab");
  await expect(doc).toHaveAttribute("data-blocks", "1", { timeout: 10_000 });
  await expect(doc).toHaveAttribute("data-state", "saved");
  const id = (await api.doc.list()).find((d) => d.title === title)!.id;
  expect((await api.doc.get({ id })).blocks.filter((b) => !b.deleted).map((b) => b.text.map((s) => s.t).join(""))).toEqual(["firstsecond"]);
});
