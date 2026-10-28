import { defaultOrchestrator } from "@vibevalley/protocol";
import { expect, tab, test } from "./fixtures";

test("a helper is made, edited, turned off and deleted", async ({ page, api }) => {
  const name = "test fox";
  const duty = "runs and writes tests";
  await page.goto("/agents");
  await expect(page.locator(`[data-testid="agent-card"][data-key="${defaultOrchestrator}"]`)).toBeVisible();
  await page.getByTestId("new-agent").click();
  await expect(page).toHaveURL(/\/agents\/new$/);
  const bar = page.getByTestId("profile-bar");
  await expect(bar).toHaveAttribute("data-state", "new");
  await page.getByTestId("agent-name").fill(name);
  await page.getByTestId("agent-duty").fill(duty);
  await tab(page, "persona").click();
  await page.getByTestId("agent-persona").fill("Write the test before the code.");
  await tab(page, "env").click();
  await page.getByTestId("new-pair-name").fill("CI");
  await page.getByTestId("new-pair-value").fill("1");
  await page.getByTestId("new-pair-add").click();
  const ci = page.locator('[data-testid="pair-value"][data-key="CI"]');
  await expect(ci).toHaveValue("1");
  // Typed key by key: the row stays, so the field keeps its focus.
  await ci.press("End");
  await ci.pressSequentially("23");
  await expect(ci).toHaveValue("123");
  await ci.fill("1");
  await bar.getByTestId("save").click();
  await expect(page).toHaveURL(/\/agents\/(?!new).+/);
  await expect(bar).toHaveAttribute("data-state", "saved");
  const id = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
  const made = (await api.agent.list()).find((a) => a.id === id)!;
  expect([made.name, made.duty, made.env]).toEqual([name, duty, { CI: "1" }]);

  await tab(page, "who").click();
  await page.getByTestId("agent-duty").fill("only runs tests");
  await expect(bar).toHaveAttribute("data-state", "dirty");
  await bar.getByTestId("discard").click();
  await expect(page.getByTestId("agent-duty")).toHaveValue(duty);

  await bar.getByTestId("back").click();
  const card = page.locator(`[data-testid="agent-card"][data-key="${id}"]`);
  await card.hover();
  await card.getByTestId("toggle").click();
  await expect(card.getByTestId("toggle")).toHaveAttribute("data-state", "off");

  await card.getByRole("link").click();
  await bar.getByTestId("delete").click();
  await bar.getByTestId("delete-sure").click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(card).toHaveCount(0);
});

test("a profile that does not exist says so", async ({ page }) => {
  await page.goto("/agents/nobody-here");
  await expect(page.getByTestId("agent-missing")).toBeVisible();
});
