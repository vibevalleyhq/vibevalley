import { diagnosticsOf } from "./browser";
import { expect, test as base } from "./fixtures";

const test = base.extend({
  page: async ({ page }, use) => {
    const check = diagnosticsOf(page);
    await use(page);
    check();
  },
});

test("regression: invalid issue search never silently chooses the first value", async ({ page }) => {
  await page.goto("/issues?repo=one&repo=two");
  await expect(page.getByTestId("route-missing")).toBeVisible();
  await expect(page.getByTestId("desk")).toHaveCount(0);
  await page.goto("/issues?repo=one");
  await expect(page.getByTestId("route-missing")).toHaveCount(0);
  await expect(page.getByTestId("desk")).toBeVisible();
});

test("regression: the farm stays inside the same application shell across navigation and history", async ({ page, api }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
  await api.repo.create({ name: "router-farm" });
  await page.goto("/issues");
  const rail = page.getByTestId("rail");
  const original = await rail.elementHandle();
  await rail.locator('[data-place="farm"]').first().click();
  await expect(page).toHaveURL(/\/farm\/router-farm$/u);
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true");
  expect(await rail.evaluate((current, previous) => current === previous, original)).toBe(true);
  await expect(rail.locator('[data-place="farm"]').first()).toHaveAttribute("aria-current", "page");
  const bounds = await page.getByTestId("farm").boundingBox();
  const navigation = await rail.boundingBox();
  if (!bounds || !navigation) throw new Error("Farm and navigation must both have visible bounds");
  expect(bounds.x).toBeGreaterThanOrEqual(navigation.x + navigation.width);
  await expect(page.getByTestId("desk")).toHaveCount(0);
  await rail.locator('[data-place="issues"]').click();
  await expect(page.getByTestId("issue-search")).toBeVisible();
  expect(await rail.evaluate((current, previous) => current === previous, original)).toBe(true);
  await page.goBack();
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true");
  await page.goForward();
  await expect(page.getByTestId("issue-search")).toBeVisible();
});

test("regression: changing an issue parameter preserves its page and unsaved filter", async ({ page, api }) => {
  const one = await api.issue.create({ title: "router one" });
  const two = await api.issue.create({ title: "router two" });
  await page.goto("/issues");
  const search = page.getByTestId("issue-search");
  await search.fill("router");
  const owner = page.getByTestId("issues-page");
  const original = await owner.elementHandle();
  await page.locator(`[data-testid="issue-card"][data-key="${one.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${one.id}$`, "u"));
  expect(await owner.evaluate((current, previous) => current === previous, original)).toBe(true);
  await page.getByTestId("issue-close").click();
  await expect(search).toHaveValue("router");
  await page.locator(`[data-testid="issue-card"][data-key="${two.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${two.id}$`, "u"));
  expect(await owner.evaluate((current, previous) => current === previous, original)).toBe(true);
});

test("regression: an invalid encoded route and an unknown page never become a writable default page", async ({ page }) => {
  await page.goto("/issues");
  for (const path of ["/farm/%E0%A4", "/not-a-page"]) {
    const link = page.getByTestId("rail").locator('[data-place="farm"]').first();
    await link.evaluate((anchor, href) => anchor.setAttribute("href", href), path);
    await link.click();
    await expect(page.getByTestId("route-missing")).toBeVisible();
    await expect(page.getByTestId("composer")).toHaveCount(0);
    await page.getByTestId("route-missing").locator("a").click();
    await expect(page.getByTestId("rail")).toBeVisible();
  }
});

test("regression: the first-visit title does not capture Enter on the application navigation", async ({ page }) => {
  await page.goto("/farm/");
  await expect(page.getByTestId("title")).toBeVisible();
  const issues = page.getByTestId("rail").locator('[data-place="issues"]');
  await issues.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/issues$/u);
  await expect(page.getByTestId("issue-search")).toBeVisible();
});

test("regression: a null model-key source keeps the title open and never starts the orchestrator", async ({ page, api }) => {
  expect((await api.setting.get()).deepseekApiKey.source).toBeNull();
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/orchestrator/open")) requests.push(request.url());
  });
  await page.goto("/farm/");
  const title = page.getByTestId("title");
  await title.locator('[data-key="start"]').click();
  await expect(title.getByRole("status")).toBeVisible();
  expect(requests).toEqual([]);
});

test("regression: an unknown place only opens the workbench after explicit navigation", async ({ page }) => {
  await page.goto("/nowhere-at-all");
  await expect(page).toHaveURL(/\/nowhere-at-all$/u);
  const missing = page.getByTestId("route-missing");
  await expect(missing).toBeVisible();
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await missing.getByRole("link").click();
  await expect(page).toHaveURL(/\/chat$/u);
});
