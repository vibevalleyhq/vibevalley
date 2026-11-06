import type { Agent } from "@vibevalley/protocol";

import { expect, test } from "./fixtures";

test.use({ farm: "flow-polish" });

const fox: Agent = {
  id: "",
  name: "fox",
  role: "worker",
  duty: "",
  enabled: true,
  // The test server's pi is the scripted helper (fixtures.ts); ask-first has it ask the owner.
  runtime: "pi",
  model: "",
  effort: "",
  persona: "",
  personaMode: "append",
  skills: [],
  mcpServers: [],
  disallowedTools: [],
  env: {},
  workdir: "",
  worktree: true,
  tags: [],
  look: { species: "fox", outfit: "farmer", build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "" },
};

test("a dispatch links its issue, and what waits on the owner is counted on the rail and in the title", async ({ page, api }) => {
  const helper = await api.agent.create(fox);
  const project = await api.project.create({ name: "polish" });
  const made = await api.issue.create({ title: "打卡页先问清楚", project: project.name, agent: helper.id });
  await page.goto("/chat");
  await expect(page.locator('[data-testid="rail"] [data-place="issues"]')).not.toHaveAttribute("data-badge");
  await api.issue.status.update({ id: made.id, status: "todo" });

  const badge = page.locator('[data-testid="rail"] [data-place="issues"] [data-testid="rail-badge"]');
  await expect(badge).toHaveText("1", { timeout: 30_000 });
  await expect(page).toHaveTitle(/^\(1!/u);

  const sent = page.getByTestId("dispatch-issue");
  await expect(sent).toHaveAttribute("href", `/issues/${made.id}`);
  await sent.click();
  await expect(page).toHaveURL(new RegExp(`/issues/${made.id}$`, "u"));
  for (const line of await page.getByTestId("milestone").allTextContents()) expect(line).not.toMatch(/(^|\s)#{1,6}\s|```/u);
});
