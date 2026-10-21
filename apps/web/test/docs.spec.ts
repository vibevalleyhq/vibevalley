import { expect, test } from "./fixtures";

test("a document is made and written block by block, and what is written is kept", async ({ page }) => {
  const title = `周报 ${Date.now() % 100000}`;
  await page.goto("/docs");
  await page.getByLabel("新文档的标题").fill(title);
  await page.getByRole("button", { name: "新文档" }).click();
  const doc = page.getByRole("article", { name: title });
  await expect(doc.getByRole("heading", { name: title })).toBeVisible();
  await doc.getByRole("button", { name: "在末尾写一段" }).click();
  await page.keyboard.type("# 本周");
  await page.keyboard.type("做完的事");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- 看板");
  await page.keyboard.press("Enter");
  await page.keyboard.type("聊天");
  await page.keyboard.press("Tab");
  await expect(doc.getByRole("status")).toContainText("都存好了", { timeout: 10_000 });
  await page.reload();
  const again = page.getByRole("article", { name: title });
  await expect(again.getByText("本周做完的事")).toBeVisible();
  await expect(again.getByText("看板")).toBeVisible();
  await expect(again.getByText("聊天")).toBeVisible();
  await expect(again.getByText("•")).toHaveCount(2);
});

test("the demo has helpers write in the document", async ({ page }) => {
  const title = `演示 ${Date.now() % 100000}`;
  await page.goto("/docs");
  await page.getByLabel("新文档的标题").fill(title);
  await page.getByRole("button", { name: "新文档" }).click();
  const doc = page.getByRole("article", { name: title });
  await doc.getByRole("button", { name: "演示：几个帮工一起写" }).click();
  await expect(doc.getByRole("status")).toContainText("帮工在写", { timeout: 15_000 });
  await expect(doc.locator("[data-block]").first()).toBeVisible({ timeout: 15_000 });
  await expect(doc.getByLabel(/在写$/).first()).toBeVisible({ timeout: 15_000 });
});

test("Backspace at a block's start joins it to the one before", async ({ page, api }) => {
  const title = `合并 ${Date.now() % 100000}`;
  await page.goto("/docs");
  await page.getByLabel("新文档的标题").fill(title);
  await page.getByRole("button", { name: "新文档" }).click();
  const doc = page.getByRole("article", { name: title });
  await doc.getByRole("button", { name: "在末尾写一段" }).click();
  await page.keyboard.type("前半");
  await page.keyboard.press("Enter");
  await page.keyboard.type("后半");
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Tab");
  await expect(doc.getByRole("status")).toContainText("都存好了 · 1 块", { timeout: 10_000 });
  const id = (await api.doc.list()).find((d) => d.title === title)!.id;
  expect((await api.doc.get({ id })).blocks.filter((b) => !b.deleted).map((b) => b.text.map((s) => s.t).join(""))).toEqual(["前半后半"]);
});

test("文档 as it looks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const title = `样子 ${Date.now() % 100000}`;
  await page.goto("/docs");
  await page.getByLabel("新文档的标题").fill(title);
  await page.getByRole("button", { name: "新文档" }).click();
  const doc = page.getByRole("article", { name: title });
  await doc.getByRole("button", { name: "演示：几个帮工一起写" }).click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: test.info().outputPath("docs.png") });
});
