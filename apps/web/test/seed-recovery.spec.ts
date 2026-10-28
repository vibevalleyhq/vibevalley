import type { Page } from "@playwright/test";
import { pathOf } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";

const draft = "keep the idea I just wrote";

async function openBag(page: Page, project: string) {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
  await page.goto(`/farm/${project}`);
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  const box = (await page.getByTestId("village").locator("canvas").boundingBox())!;
  const scale = box.width / 384;
  await page.mouse.click(box.x + 128 * scale, box.y + 117 * scale);
  return page.getByTestId("sow");
}

test("one lost seed request retries through the query observer and loads the real project templates", async ({ page, api }) => {
  const project = await api.project.create({ name: "seed-retry-once" });
  let attempts = 0;
  await page.route(`**${pathOf("project.template.list")}`, (route) => (++attempts === 1 ? route.abort("connectionrefused") : route.continue()));
  const bag = await openBag(page, project.name);
  await expect(bag.getByTestId("seed-kinds")).toBeVisible();
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
  const problem = bag.getByRole("alert");
  await expect(problem).toBeVisible();
  expect(attempts).toBe(2);
  // The browser's own words for a refused connection are not the owner's.
  await expect(problem).not.toContainText("Failed to fetch");
  const box = bag.getByRole("textbox");
  await box.fill(draft);

  unavailable = false;
  await bag.getByTestId("seeds-retry").click();
  await expect(bag.getByTestId("seed-kinds")).toBeVisible();
  await expect(problem).toHaveCount(0);
  await expect(box).toHaveValue(draft);
  expect(attempts).toBe(3);
});
