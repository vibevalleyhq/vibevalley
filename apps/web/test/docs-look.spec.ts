// The documents page as it looks while helpers write, on a server of its own: a server runs one demo at a time, and another
// file's demo may still be writing on the shared one.

import { expect, test } from "./fixtures";

test.use({ farm: "docs-look" });

test("文档 as it looks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const title = `样子 ${Date.now() % 100000}`;
  await page.goto("/docs");
  await page.getByLabel("新文档的标题").fill(title);
  await page.getByRole("button", { name: "新文档" }).click();
  const doc = page.getByRole("article", { name: title });
  await doc.getByRole("button", { name: "演示：几个帮工一起写" }).click();
  // The picture is of helpers writing: taken once they are and a few blocks are down.
  await expect(doc.getByRole("status")).toContainText("帮工在写", { timeout: 15_000 });
  await expect.poll(() => doc.locator("[data-block]").count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await page.screenshot({ path: test.info().outputPath("docs.png") });
});
