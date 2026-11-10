import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./fixtures";
import { understandingFile } from "./understanding-fixture";

test.use({ farm: "library" });

test("an upload shows as a card, filters narrow it, it goes to a channel and comes out of the library", async ({ page, api }) => {
  const channel = await api.channel.create({ name: "library-out" });
  await page.goto("/library");
  await expect(page.getByTestId("library-empty")).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);

  const added = page.waitForResponse((response) => response.url().endsWith("/api/v1/library/item/add") && response.status() === 200);
  await page.getByTestId("library-file").setInputFiles(understandingFile("image").path);
  await added;
  const [item] = await api.library.item.list({});
  if (item === undefined) throw new Error("Expected the upload in the library");
  expect(item.origin).toEqual({ kind: "uploaded" });
  const card = page.locator(`[data-testid="library-item"][data-key="${item.attachment.id}"]`);
  await expect(card).toHaveAttribute("data-origin", "uploaded");
  await expect(card).toHaveAttribute("data-kind", "image");

  await page.getByTestId("library-origin").locator('[data-key="generated"]').click();
  await expect(card).toHaveCount(0);
  await page.getByTestId("library-origin").locator('[data-key="uploaded"]').click();
  await page.getByTestId("library-kind").locator('[data-key="image"]').click();
  await expect(card).toBeVisible();
  await page.getByTestId("library-kind").locator('[data-key="audio"]').click();
  await expect(card).toHaveCount(0);
  await page.getByTestId("library-kind").locator('[data-key="all"]').click();

  await card.getByTestId("library-channel").click();
  await page.locator(`[role="option"][data-key="${channel}"]`).click();
  await card.getByTestId("library-send").click();
  await expect(card.getByTestId("library-send")).toHaveAttribute("data-sent", "true");
  const said = await api.channel.message.list({ id: channel });
  expect(said.flatMap((m) => m.attachments.map((a) => a.id))).toContain(item.attachment.id);

  await card.getByTestId("library-remove").click();
  await card.getByTestId("library-remove-sure").click();
  await expect(card).toHaveCount(0);
  expect(await api.library.item.list({})).toEqual([]);
});
