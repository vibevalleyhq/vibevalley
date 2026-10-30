import { expect, test } from "./fixtures";

test("a new plot is opened, shows on the map and opens its own farm", async ({ page }) => {
  const name = `patch-${Date.now() % 100000}`;
  await page.goto("/projects");
  await page.getByTestId("new-project").click();
  const dialog = page.getByTestId("new-project-dialog");
  await dialog.getByTestId("project-how").locator('[data-key="new"]').click();
  // The server's check refuses a name that is not a folder's.
  await dialog.getByTestId("project-name").fill("../bad name");
  await dialog.getByTestId("submit").click();
  await expect(dialog.getByRole("alert")).not.toBeEmpty();
  await dialog.getByTestId("project-name").fill(name);
  await dialog.getByTestId("submit").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${name}$`, "u"));
  await expect(page.getByTestId("project")).toHaveAttribute("data-key", name);

  await page.getByTestId("projects").locator('[data-testid="list-row"][data-key=""]').click();
  await expect(page).toHaveURL(/\/projects$/u);
  await expect(page.locator(`[data-testid="island"][data-key="${name}"]`)).toBeVisible();
  await page.locator(`[data-testid="enter-island"][data-key="${name}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/farm/${name}$`, "u"));
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(page.getByTestId("project-sign")).toHaveAttribute("data-key", name);
});

test("the GitHub address names the project until the name is typed", async ({ page }) => {
  await page.goto("/projects");
  await page.getByTestId("new-project").click();
  const dialog = page.getByTestId("new-project-dialog");
  await dialog.getByTestId("project-github").fill("https://github.com/botiverse/raft-source");
  await expect(dialog.getByTestId("project-name")).toHaveValue("raft-source");
  await dialog.getByTestId("project-name").fill("mine");
  await dialog.getByTestId("project-github").fill("https://github.com/botiverse/other");
  await expect(dialog.getByTestId("project-name")).toHaveValue("mine");
  await dialog.getByTestId("cancel").click();
  await expect(dialog).toBeHidden();
});
