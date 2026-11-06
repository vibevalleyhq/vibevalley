import { expect, test } from "./fixtures";

test("a new plot is opened, shows on the map and opens its own farm", async ({ page }) => {
  const name = `patch-${Date.now() % 100000}`;
  await page.goto("/repos");
  await page.getByTestId("new-repo").click();
  const dialog = page.getByTestId("new-repo-dialog");
  await dialog.getByTestId("repo-how").locator('[data-key="new"]').click();
  await dialog.getByTestId("repo-name").fill("../bad name");
  await dialog.getByTestId("submit").click();
  await expect(dialog.getByRole("alert")).not.toBeEmpty();
  await dialog.getByTestId("repo-name").fill(name);
  await dialog.getByTestId("submit").click();
  await expect(page).toHaveURL(new RegExp(`/repos/${name}$`, "u"));
  await expect(page.getByTestId("repo")).toHaveAttribute("data-key", name);

  await page.getByTestId("repos").locator('[data-testid="list-row"][data-key=""]').click();
  await expect(page).toHaveURL(/\/repos$/u);
  await expect(page.locator(`[data-testid="island"][data-key="${name}"]`)).toBeVisible();
  await page.locator(`[data-testid="enter-island"][data-key="${name}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/farm/${name}$`, "u"));
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(page.getByTestId("repo-sign")).toHaveAttribute("data-key", name);
});

test("the GitHub address names the repo until the name is typed", async ({ page }) => {
  await page.goto("/repos");
  await page.getByTestId("new-repo").click();
  const dialog = page.getByTestId("new-repo-dialog");
  await dialog.getByTestId("repo-github").fill("https://github.com/botiverse/raft-source");
  await expect(dialog.getByTestId("repo-name")).toHaveValue("raft-source");
  await dialog.getByTestId("repo-name").fill("mine");
  await dialog.getByTestId("repo-github").fill("https://github.com/botiverse/other");
  await expect(dialog.getByTestId("repo-name")).toHaveValue("mine");
  await dialog.getByTestId("cancel").click();
  await expect(dialog).toBeHidden();
});
