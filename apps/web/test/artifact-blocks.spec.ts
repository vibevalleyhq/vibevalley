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

test("a suggestion shows its diff, and accepting it changes the block", async ({ page, api }) => {
  const made = await api.artifact.create({ title: `suggestion ${Date.now() % 100000}`, kind: "markdown", content: "owner line" });
  const block = (await api.artifact.block.list({ id: made.id })).blocks[0]!;
  await api.artifact.suggestion.create({
    id: made.id,
    block: block.id,
    baseRev: block.rev,
    change: { text: [{ t: "agent line", marks: {} }] },
  });
  await page.goto(`/artifacts/${made.id}`);
  const panel = page.getByTestId("artifact-suggestions");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("agent line");
  await page.getByTestId("suggestion-accept").click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("artifact-blocks")).toContainText("agent line");
});

test("a suggestion whose block moved on is stale and cannot be accepted", async ({ page, api }) => {
  const made = await api.artifact.create({ title: `stale ${Date.now() % 100000}`, kind: "markdown", content: "first" });
  const block = (await api.artifact.block.list({ id: made.id })).blocks[0]!;
  await api.artifact.suggestion.create({
    id: made.id,
    block: block.id,
    baseRev: block.rev,
    change: { text: [{ t: "too late", marks: {} }] },
  });
  await api.artifact.block.update({ id: made.id, block: block.id, baseRev: block.rev, text: "owner moved on" });
  await page.goto(`/artifacts/${made.id}`);
  const suggestion = page.getByTestId("artifact-suggestion");
  await expect(suggestion).toHaveAttribute("data-status", "stale");
  await expect(page.getByTestId("suggestion-accept")).toBeDisabled();
  await page.getByTestId("suggestion-reject").click();
  await expect(page.getByTestId("artifact-suggestions")).toHaveCount(0);
});

test("on a phone a suggestion is readable and can be accepted from the keyboard", async ({ page, api }) => {
  const made = await api.artifact.create({ title: `phone ${Date.now() % 100000}`, kind: "markdown", content: "phone block" });
  const block = (await api.artifact.block.list({ id: made.id })).blocks[0]!;
  await api.artifact.suggestion.create({ id: made.id, block: block.id, baseRev: block.rev, change: { text: [{ t: "phone suggestion", marks: {} }] } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/artifacts/${made.id}`);
  const panel = page.getByTestId("artifact-suggestions");
  await expect(panel).toBeVisible();
  await page.getByTestId("suggestion-accept").focus();
  await page.keyboard.press("Enter");
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("artifact-blocks")).toContainText("phone suggestion");
});

test("type, attribute and delete suggestions each show their diff, reject, and survive a reload", async ({ page, api }) => {
  const made = await api.artifact.create({ title: `kinds ${Date.now() % 100000}`, kind: "markdown", content: "a line\n\n- [ ] task" });
  const [line, todo] = (await api.artifact.block.list({ id: made.id })).blocks;
  await api.artifact.suggestion.create({ id: made.id, block: line!.id, baseRev: line!.rev, change: { type: "heading", attrs: { level: 2 } } });
  await api.artifact.suggestion.create({ id: made.id, block: line!.id, baseRev: line!.rev, change: { delete: true } });
  await api.artifact.suggestion.create({ id: made.id, block: todo!.id, baseRev: todo!.rev, change: { attrs: { checked: true } } });
  await page.goto(`/artifacts/${made.id}`);
  await expect(page.locator('[data-testid="artifact-suggestion"][data-change="type"]')).toBeVisible();
  await expect(page.locator('[data-testid="artifact-suggestion"][data-change="attrs"]')).toBeVisible();
  const remove = page.locator('[data-testid="artifact-suggestion"][data-change="delete"]');
  await expect(remove).toBeVisible();
  await remove.getByTestId("suggestion-reject").click();
  await expect(remove).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-testid="artifact-suggestion"][data-change="type"]')).toBeVisible();
  await expect(page.locator('[data-testid="artifact-suggestion"][data-change="attrs"]')).toBeVisible();
  await page.locator('[data-testid="artifact-suggestion"][data-change="type"]').getByTestId("suggestion-accept").click();
  await expect(page.locator('[data-testid="artifact-suggestion"][data-change="type"]')).toHaveCount(0);
  await expect.poll(async () => (await api.artifact.block.list({ id: made.id })).blocks.find((b) => b.id === line!.id)?.type).toBe("heading");
  await page.locator('[data-testid="artifact-suggestion"][data-change="attrs"]').getByTestId("suggestion-accept").click();
  await expect.poll(async () => (await api.artifact.block.list({ id: made.id })).blocks.find((b) => b.id === todo!.id)?.attrs.checked).toBe(true);
});
