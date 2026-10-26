import { expect, test } from "./fixtures";

// A server of its own: the language is the whole farm's, and every other file reads the Chinese.
test.use({ farm: "english" });

test("the farm speaks English once the owner picks it, and Chinese again", async ({ page, api }) => {
  await api.issue.create({ body: { title: "Add paging to clock-in" } });
  await page.goto("/settings/language");
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  const nav = page.getByRole("navigation", { name: "Workbench" });
  for (const label of ["Chat", "Tickets", "Docs", "Helpers", "Machines", "Projects", "Catalog", "Settings"])
    await expect(nav.getByRole("link", { name: new RegExp(`^${label} · `) })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Connected");
  await expect(page.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");

  // The board's lanes are the page's words; a card's status is the server's, in the same language.
  await nav.getByRole("link", { name: /^Tickets · / }).click();
  await expect(page.getByText("Add paging to clock-in")).toBeVisible();
  for (const lane of ["To do", "In progress", "For you to see", "Closed"]) await expect(page.getByText(lane, { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("issues-en.png") });

  // The server's own words follow: the voice line's default greeting, the machines' blurbs.
  const settings = await api.setting.load();
  expect(settings.locale).toBe("en");
  expect(settings.voiceDefaults.greeting).toBe("Hey there! What shall we grow today?");
  await nav.getByRole("link", { name: /^Machines · / }).click();
  await expect(page.getByRole("region", { name: "Machines" })).toBeVisible();

  await page.goto("/settings/language");
  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(page.getByRole("navigation", { name: "工作台" })).toBeVisible();
});
