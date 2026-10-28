import { expect, tab, test, defaultChannel } from "./fixtures";

test("the orchestrator's memory takes a note and forgets it", async ({ page }) => {
  const note = "write commit messages in English";
  await page.goto("/orchestrator");
  await expect(tab(page, "memory")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("note-input").fill(note);
  await page.getByTestId("note-write").click();
  const kept = page.getByTestId("notes").getByTestId("memory").filter({ hasText: note });
  await expect(kept).toBeVisible();
  await kept.hover();
  await kept.getByTestId("forget").click();
  await expect(kept).toHaveCount(0);
});

test("the orchestrator's trajectory shows what it was told, and a round it never heard cannot be marked wrong", async ({ page, api }) => {
  const told = "look at the clock-in page";
  // Without the model's key the orchestrator cannot start: the line is in its log, not in its channel.
  await api.channel.message.send({ id: await defaultChannel(api), text: told });
  await page.goto("/orchestrator/trajectory");
  const row = page.getByTestId("step").filter({ hasText: told }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.hover();
  await page.getByTestId("mark-wrong").first().click();
  await page.getByTestId("mark-want").fill("ask me which project first");
  await page.getByTestId("mark-submit").click();
  // The server refuses it, and the page says so.
  await expect(page.getByTestId("toast")).toBeVisible();
  await page.getByTestId("trajectory-search").fill("nothing like this");
  await expect(page.getByTestId("steps-empty")).toBeVisible();
});

test("the archive and the orchestrator's voice", async ({ page }) => {
  await page.goto("/orchestrator/archive");
  await expect(page.getByTestId("archive")).toHaveAttribute("data-count", "0");
  await tab(page, "voice").click();
  await expect(page).toHaveURL(/\/orchestrator\/voice$/);
  const greeting = page.getByTestId("greeting");
  const before = await greeting.inputValue();
  await greeting.fill("Here I am, what shall we grow?");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-bar")).not.toHaveAttribute("data-dirty");
  await page.reload();
  await expect(greeting).toHaveValue("Here I am, what shall we grow?");
  await greeting.fill(before);
  await page.getByTestId("save").click();
  await expect(page.getByTestId("save-bar")).not.toHaveAttribute("data-dirty");
});
