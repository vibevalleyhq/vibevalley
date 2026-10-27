import type { Page } from "@playwright/test";
import { pathOf } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";

async function openBag(page: Page, project: string) {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
  await page.goto(`/farm/${project}`);
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  const box = (await page.getByTestId("village").locator("canvas").boundingBox())!;
  const scale = box.width / 384;
  await page.mouse.click(box.x + 128 * scale, box.y + 117 * scale);
  return page.getByRole("dialog", { name: "播种 · 第 1 块地" });
}

test("one lost seed request retries through the query observer and loads the real project templates", async ({ page, api }) => {
  const project = await api.project.create({ name: "seed-retry-once" });
  let attempts = 0;
  await page.route(`**${pathOf("project.template.list")}`, (route) => (++attempts === 1 ? route.abort("connectionrefused") : route.continue()));
  const bag = await openBag(page, project.name);
  await expect(bag.getByRole("tablist", { name: "常见的活" })).toBeVisible();
  expect(attempts).toBe(2);
});

test("the seed bag can retry after the server is reachable again without losing the owner's draft", async ({ page, api }) => {
  const project = await api.project.create({ name: "seed-recover" });
  let unavailable = true;
  let attempts = 0;
  await page.route(`**${pathOf("project.template.list")}`, (route) => {
    attempts++;
    return unavailable ? route.abort("connectionrefused") : route.continue();
  });
  const bag = await openBag(page, project.name);
  await expect(bag.getByText(/^种子袋没拿到/)).toBeVisible();
  expect(attempts).toBe(2);
  const draft = bag.getByRole("textbox", { name: "工单" });
  await draft.fill("保留我刚写下的想法");
  await expect(bag.getByText(/^种子袋没拿到/)).toContainText("暂时连不上服务端");
  await expect(bag).not.toContainText("Failed to fetch");
  await page.screenshot({ path: test.info().outputPath("seed-disconnected.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath("seed-disconnected-narrow.png") });
  await page.setViewportSize({ width: 1280, height: 800 });

  unavailable = false;
  await bag.getByRole("button", { name: "重新拿种子袋" }).click();
  await expect(bag.getByRole("tablist", { name: "常见的活" })).toBeVisible();
  await expect(bag.getByText(/^种子袋没拿到/)).toHaveCount(0);
  await expect(draft).toHaveValue("保留我刚写下的想法");
  expect(attempts).toBe(3);
  await page.screenshot({ path: test.info().outputPath("seed-recovered.png") });
});
