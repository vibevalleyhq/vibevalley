import type { Page } from "@playwright/test";
import { attachmentPath, type VibeValleyApi } from "@vibevalley/protocol";
import { composerOn, expect, test } from "./fixtures";

// The smallest PNG there is: one transparent pixel.
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

const row = (page: Page, id: string) => page.getByTestId("messages").locator(`[data-testid="message"][data-key="${id}"]`);
const idOf = async (api: VibeValleyApi, channel: string, text: string) => (await api.channel.message.list({ id: channel })).find((m) => m.text === text)!.id;

/** A tool over a message, shown while it is hovered. */
async function tool(page: Page, id: string, key: string) {
  await row(page, id).hover();
  await row(page, id).locator(`[data-testid="message-tool"][data-key="${key}"]`).click();
}

test("a message is answered, changed, reacted to, pinned and deleted from the tools over it", async ({ page, api }) => {
  const id = await api.channel.create({ name: "talk" });
  await api.channel.message.send({ id, text: "water the apples" });
  const first = await idOf(api, id, "water the apples");
  await page.goto(`/chat/${id}`);
  await expect(row(page, first)).toBeVisible();

  await tool(page, first, "reply");
  const replying = page.getByTestId("replying");
  await expect(replying).toBeVisible();
  const box = await composerOn(page, id);
  await box.fill("on it");
  await box.press("Enter");
  await expect.poll(async () => (await api.channel.message.list({ id })).some((m) => m.text === "on it")).toBe(true);
  const answer = await idOf(api, id, "on it");
  await expect(row(page, answer)).toBeVisible();
  await expect(replying).toHaveCount(0);

  await tool(page, first, "edit");
  const editing = row(page, first).getByTestId("message-edit");
  await editing.fill("water the apples more");
  await editing.press("Enter");
  await expect(row(page, first)).toHaveAttribute("data-edited", "");
  await expect(row(page, first)).toContainText("water the apples more");

  await tool(page, answer, "react");
  await row(page, answer).locator('[data-testid="quick-reaction"][data-key="🎉"]').click();
  const party = row(page, answer).locator('[data-testid="reaction"][data-key="🎉"]');
  await expect(party).toHaveAttribute("data-count", "1");
  await expect(party).toHaveAttribute("aria-pressed", "true");

  await tool(page, answer, "pin");
  await expect(row(page, answer)).toHaveAttribute("data-pinned", "");
  await page.getByTestId("pins-toggle").click();
  await expect(page.getByTestId("pins").locator(`[data-testid="pin"][data-key="${answer}"]`)).toBeVisible();
  await page.getByTestId("pins-toggle").click();

  await page.getByTestId("members-toggle").click();
  await expect(page.getByTestId("members").getByTestId("member-orchestrator")).toBeVisible();

  await tool(page, answer, "delete");
  const remove = row(page, answer).locator('[data-testid="message-tool"][data-key="delete"]');
  await expect(remove).toHaveAttribute("data-sure", "");
  await remove.click();
  await expect(row(page, answer)).toHaveAttribute("data-deleted", "");
  await expect(row(page, answer)).not.toContainText("on it");
});

test("a change made elsewhere reaches the page as it happens", async ({ page, api }) => {
  const id = await api.channel.create({ name: "elsewhere" });
  await api.channel.message.send({ id, text: "look at this" });
  const said = await idOf(api, id, "look at this");
  await page.goto(`/chat/${id}`);
  await expect(row(page, said)).toBeVisible();
  await api.channel.reaction.toggle({ id: said, emoji: "👍" });
  await expect(row(page, said).locator('[data-testid="reaction"][data-key="👍"]')).toHaveAttribute("data-count", "1");
  await api.channel.message.update({ id: said, text: "look at this, please" });
  await expect(row(page, said)).toContainText("look at this, please");
});

test("a picture picked for a message shows in it and opens at its own address", async ({ page, api, server }) => {
  const id = await api.channel.create({ name: "pictures" });
  await page.goto(`/chat/${id}`);
  const box = await composerOn(page, id);
  await page.locator('input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: pixel });
  await expect(page.locator('[data-testid="pending-file"][data-key="shot.png"]')).toBeVisible();
  await box.press("Enter");
  const image = page.getByTestId("messages").locator('[data-testid="attachment"][data-kind="image"] img');
  await expect(image).toBeVisible();
  const src = await image.getAttribute("src");
  const [said] = await api.channel.message.list({ id });
  expect(src).toBe(attachmentPath(said!.attachments![0]!.id));
  const res = await fetch(server.url + src);
  expect([res.status, res.headers.get("content-type")]).toEqual([200, "image/png"]);
});
