import { defaultOrchestrator } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";

test.use({ farm: "runtime-avatars" });

test("helper avatars show their actual runtime on cards and small issue rows", async ({ page, api }) => {
  const profiles = await api.agent.list();
  const codex = profiles.find((a) => a.runtime === "codex");
  const claude = profiles.find((a) => a.runtime === "claude");
  if (!codex || !claude) throw new Error("the farm's seed profiles must include Codex and Claude Code");
  for (const a of profiles) if (![defaultOrchestrator, codex.id, claude.id].includes(a.id)) await api.agent.delete({ id: a.id });
  await api.issue.create({ title: "for codex", assignee: codex.id });
  await api.issue.create({ title: "for claude", assignee: claude.id });

  await page.goto("/agents");
  for (const a of [codex, claude]) {
    const badge = page.locator(`[data-testid="agent-card"][data-key="${a.id}"] [data-runtime]`);
    await expect(badge).toHaveAttribute("data-runtime", a.runtime);
    await expect(badge.locator("img")).toHaveAttribute("src", `/pixel/logo-${a.runtime}.png`);
    await expect.poll(() => badge.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  }
  const orchestrator = page.locator(`[data-testid="agent-card"][data-key="${defaultOrchestrator}"]`);
  await expect(orchestrator).toBeVisible();
  await expect(orchestrator.locator("[data-runtime]")).toHaveCount(0);

  await page.goto("/issues");
  await page.getByTestId("issue-view").locator('[data-key="list"]').click();
  await page.getByTestId("display").click();
  await page.getByTestId("grouping").locator('[data-key="agent"]').click();
  await page.getByTestId("display").click();
  for (const runtime of ["codex", "claude"]) await expect(page.locator(`main [data-runtime="${runtime}"]`).first()).toBeVisible();
});
