import { expect, test } from "./fixtures";

test("the runtimes list what oar found, and a runtime's settings are saved and put back", async ({ page }) => {
  await page.goto("/runtimes");
  const list = page.getByTestId("runtimes");
  await expect(list.getByTestId("list-row").first()).toBeVisible();
  await list.locator('[data-testid="list-row"][data-key="pi"]').click();
  await expect(page).toHaveURL(/\/runtimes\/pi$/);
  const most = page.getByTestId("max-working");
  await most.fill("2");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("discard")).toBeHidden();
  await page.reload();
  await expect(most).toHaveValue("2");
  await most.fill("");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("discard")).toBeHidden();
  await page.getByTestId("new-agent").click();
  await expect(page).toHaveURL(/\/agents\/new\?runtime=pi$/);
  await expect(page.getByTestId("agent-name")).not.toHaveValue("");
});
