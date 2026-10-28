import { expect, test } from "./fixtures";

// The playground's line goes through the server, which holds the key: with none saved, the server's refusal reaches the
// page and the line goes back to idle.
test("the MOSS Live playground shows the server's refusal while no key is saved", async ({ page }) => {
  await page.goto("/settings/moss");
  const line = page.getByTestId("moss-line");
  await expect(line).toHaveAttribute("data-state", "idle");
  await expect(line.getByTestId("moss-qos")).toBeVisible();
  await line.getByTestId("moss-talk").click();
  await expect(line.getByRole("alert")).not.toBeEmpty();
  await expect(line).toHaveAttribute("data-state", "idle");
  await expect(line.getByTestId("moss-events")).toBeVisible();
});
