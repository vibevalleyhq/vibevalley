import { defaultOrchestrator } from "@vibevalley/protocol";

import { composerOn, expect, tab, test } from "./fixtures";

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
  // The new one goes into the channel and the default one comes out: the channel's orchestrator is the new one.
  await dialog.locator(`[data-testid="channel-member"][data-key="${id}"]`).click();
  await dialog.locator(`[data-testid="channel-member"][data-key="${defaultOrchestrator}"]`).click();
  await dialog.getByTestId("submit").click();
  await expect(page.getByTestId("channel-orchestrator-line")).toHaveAttribute("data-key", id);
  const kept = (await api.channel.list()).filter((c) => c.id === general.id);
  expect(kept.map((c) => [c.members, c.orchestrator])).toEqual([[[id], id]]);

  // /imagegen is said to the orchestrator in the place alone: in a channel no one is in, the default one still hears it.
  // Without a model key it says it cannot start; that it says anything there is that the line reached it.
  const drawings = await api.channel.create({ name: "drawings" });
  await api.channel.update({ id: drawings, members: [] });
  await page.goto(`/chat/${drawings}`);
  const drawingsBox = await composerOn(page, drawings);
  await drawingsBox.fill("/im");
  await expect(page.getByTestId("mentions").locator('[role="option"][data-key="/imagegen"]')).toBeVisible();
  await drawingsBox.fill("/imagegen 一只在麦田里打盹的橘猫");
  await drawingsBox.press("Enter");
  await expect(page.getByTestId("messages").locator(`[data-testid="message"][data-from="${defaultOrchestrator}"]`).first()).toBeVisible({
    timeout: 15_000,
  });

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
