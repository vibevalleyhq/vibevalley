import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./fixtures";
import { understandingFile } from "./understanding-fixture";

test.use({ farm: "library" });

test("files go in picked and dropped, the rail narrows them, the inspector shows one and sends it, and Delete takes it out", async ({ page, api }) => {
  const channel = await api.channel.create({ name: "library-out" });
  await page.goto("/library");
  await expect(page.getByTestId("library-empty")).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);

  const added = page.waitForResponse((response) => response.url().endsWith("/api/v1/library/item/add") && response.status() === 200);
  await page.getByTestId("library-file").setInputFiles(understandingFile("image").path);
  await added;
  const [picture] = await api.library.item.list({});
  if (picture === undefined) throw new Error("Expected the upload in the library");
  expect(picture.origin).toEqual({ kind: "uploaded" });
  const tile = page.locator(`[data-testid="library-item"][data-key="${picture.attachment.id}"]`);
  await expect(tile).toHaveAttribute("data-kind", "image");

  // A file dropped on the page goes in as well.
  const dropped = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["GET /checkins"], "drop.txt", { type: "text/plain" }));
    return data;
  });
  await page.getByTestId("library-page").dispatchEvent("dragover", { dataTransfer: dropped });
  await expect(page.getByTestId("library-drop")).toBeVisible();
  await page.getByTestId("library-page").dispatchEvent("drop", { dataTransfer: dropped });
  await expect.poll(() => api.library.item.list({}).then((items) => items.length)).toBe(2);
  const note = page.locator('[data-testid="library-item"][data-kind="other"]');
  await expect(note).toBeVisible();

  const rail = page.getByTestId("library-rail");
  await rail.locator('[data-testid="library-kind"][data-key="image"]').click();
  await expect(note).toHaveCount(0);
  await expect(tile).toBeVisible();
  await rail.locator('[data-testid="library-kind"][data-key="all"]').click();
  await rail.locator('[data-testid="library-where"][data-key="generated"]').click();
  await expect(tile).toHaveCount(0);
  await rail.locator('[data-testid="library-where"][data-key="all"]').click();

  await tile.click();
  const inspector = page.getByTestId("library-inspector");
  await expect(inspector).toHaveAttribute("data-count", "1");
  await expect(inspector.getByTestId("library-inspector-name")).toHaveText(picture.attachment.name);
  await inspector.getByTestId("library-send").click();
  await page.locator(`[role="menuitem"][data-key="${channel}"]`).click();
  // The channel's newest message carries the file.
  await expect.poll(() => api.channel.message.list({ id: channel }).then((said) => said[said.length - 1]?.attachments[0]?.id)).toBe(picture.attachment.id);

  // Delete asks in place, then the file comes out of the library.
  await page.getByTestId("library-grid").press("Delete");
  await inspector.getByTestId("library-remove-sure").click();
  await expect(tile).toHaveCount(0);
  await expect.poll(() => api.library.item.list({}).then((items) => [items.length, items[0]?.attachment.name])).toEqual([1, "drop.txt"]);
});
