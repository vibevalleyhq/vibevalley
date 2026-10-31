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
  await expect(page).toHaveURL(/\/artifacts\/[^/?]+$/u);
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

test("a card opens the artifact beside the chat, and a block comes into the message as a reference", async ({ page, api }) => {
  const title = `canvas ${Date.now() % 100000}`;
  await api.artifact.create({ title, kind: "markdown", content: "# Hi\n\nbody" });
  await page.goto("/chat");
  await page.getByTestId("artifact-card").filter({ hasText: title }).click();
  const canvas = page.getByTestId("artifact-canvas");
  await expect(canvas).toBeVisible();
  await expect(page).toHaveURL(/artifact=/u);
  const heading = canvas.locator('[data-type="heading"]').first();
  await heading.hover();
  await heading.getByTestId("artifact-quote-block").click();
  const paragraph = canvas.locator('[data-type="paragraph"]').first();
  await paragraph.hover();
  await paragraph.getByTestId("artifact-quote-block").click();
  await expect(page.getByTestId("quoted-block")).toHaveCount(2);
  await expect(page.getByTestId("quoted-block").first()).toContainText("Hi");
  await page.getByTestId("composer-input").fill("look at these");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("quoted-block")).toHaveCount(0);
  await expect(page.getByTestId("message-quoted-block")).toHaveCount(2);
  const general = (await api.channel.list()).find((c) => c.default)!.id;
  await expect.poll(async () => (await api.channel.message.list({ id: general, limit: 5 })).find((m) => m.text === "look at these")?.blocks?.length).toBe(2);
});

test("on a phone the canvas covers the chat, and closing it keeps what was typed", async ({ page, api }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = `canvas phone ${Date.now() % 100000}`;
  await api.artifact.create({ title, kind: "markdown", content: "phone" });
  await page.goto("/chat");
  await page.getByTestId("composer-input").fill("kept while looking");
  await page.getByTestId("artifact-card").filter({ hasText: title }).click();
  await expect(page.getByTestId("artifact-canvas")).toBeVisible();
  await page.getByTestId("artifact-canvas-close").click();
  await expect(page.getByTestId("artifact-canvas")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toHaveValue("kept while looking");
});

test("the canvas keeps the same artifact open after a reload, in the owner's theme", async ({ page, api }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.prefs", JSON.stringify({ theme: "dark" })));
  const title = `canvas theme ${Date.now() % 100000}`;
  await api.artifact.create({ title, kind: "markdown", content: "# Dark\n\nstill here" });
  await page.goto("/chat");
  await page.getByTestId("artifact-card").filter({ hasText: title }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("artifact-canvas")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("artifact-canvas")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("artifact-canvas").locator('[data-type="heading"]')).toContainText("Dark");
});
