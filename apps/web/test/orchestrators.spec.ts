import { composerOn, expect, tab, test, choose } from "./fixtures";

// A server of its own: a second orchestrator is the whole farm's, and the other files count one.
test.use({ farm: "orchestrators" });

test("a second orchestrator: made on the profiles page, answers in its own direct channel, and looks after a channel", async ({ page, api }) => {
  await page.goto("/agents");
  await page.getByTestId("new-orchestrator").click();
  await expect(page).toHaveURL(/\/agents\/new\?role=orchestrator$/u);
  await page.getByTestId("agent-name").fill("Teal");
  await page.getByTestId("agent-duty").fill("looks after notes");
  await page.locator('[role="radio"][data-key="gardener"]').click();
  const bar = page.getByTestId("profile-bar");
  await bar.getByTestId("save").click();
  await expect(page).toHaveURL(/\/agents\/(?!new).+/u);
  await expect(bar).toHaveAttribute("data-state", "saved");
  const id = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);
  const made = (await api.agent.list()).find((a) => a.id === id)!;
  expect([made.role, made.runtime, made.look.orchestrator]).toEqual(["orchestrator", "vibevalley", "gardener"]);

  // Without a model key it says it cannot start, as itself, in its own direct channel.
  await bar.getByTestId("talk").click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/u);
  const box = await composerOn(page, decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!));
  await box.fill("there?");
  await box.press("Enter");
  await expect(page.getByTestId("messages").locator(`[data-testid="message"][data-from="${id}"]`).first()).toBeVisible({
    timeout: 15_000,
  });

  const general = (await api.channel.list()).find((c) => c.default)!;
  await page.goto(`/chat/${general.id}`);
  await page.getByTestId("channel-settings-open").click();
  const dialog = page.getByTestId("channel-settings-dialog");
  await choose(dialog.getByTestId("channel-orchestrator"), id);
  await dialog.getByTestId("submit").click();
  await expect(page.getByTestId("channel-orchestrator-line")).toHaveAttribute("data-key", id);
  expect((await api.channel.list()).find((c) => c.id === general.id)!.orchestrator).toBe(id);

  await page.goto("/agents");
  await page.locator(`[data-testid="agent-card"][data-key="${id}"]`).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/orchestrator/${id}/memory$`, "u"));
  await expect(tab(page, "trajectory")).toBeVisible();
  // The phone is the default orchestrator's: another has no voice.
  await expect(tab(page, "voice")).toHaveCount(0);
  // Its memory is its own MEMORY.md: a note for it is not the default one's.
  const note = "run the notes tests first";
  await page.getByTestId("note-input").fill(note);
  await page.getByTestId("note-write").click();
  await expect(page.getByTestId("notes").getByTestId("memory").filter({ hasText: note })).toBeVisible();
  expect((await api.memory.list({ agent: "orchestrator" })).memories.map((m) => m.text)).not.toContain(note);
});
