import type { Agent, VibeValleyApi } from "@vibevalley/protocol";

import { expect, tab, test } from "./fixtures";

const first = "note the first round";
const second = "second round written while away";

const profile: Agent = {
  id: "",
  name: "trajectory-tester",
  role: "helper",
  duty: "",
  enabled: true,
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

async function finishedIssue(api: VibeValleyApi) {
  const agent = await api.agent.create(profile);
  const project = await api.project.create({ name: `log-${Date.now()}` });
  const issue = await api.issue.create({ title: first, project: project.name, assignee: agent.id });
  await api.issue.status.update({ id: issue.id, status: "todo" });
  await expect.poll(async () => (await api.issue.get({ id: issue.id })).attention.state).toBe("reviewing");
  const session = (await api.issue.get({ id: issue.id })).sessions.at(-1)!;
  return { agent, issue, session };
}

test("a reconnected trajectory catches the steps completed while its live stream was away", async ({ page, api }) => {
  const { agent, issue, session } = await finishedIssue(api);
  let reconnect: (() => void) | undefined;
  const disconnected = new Promise<void>((resolve) => {
    reconnect = resolve;
  });
  let connections = 0;
  await page.route("**/api/v1/live", async (route) => {
    if (++connections > 1) await disconnected;
    await route.fulfill({ contentType: "text/event-stream", body: ": connected\n\n" });
  });
  await page.goto(`/agents/${agent.id}`);
  await tab(page, "trajectories").click();
  await expect(page.getByTestId("step").filter({ hasText: first }).first()).toBeVisible();
  await expect.poll(() => connections).toBeGreaterThan(1);

  await api.issue.comment.create({ id: issue.id, text: second });
  await expect
    .poll(async () => (await api.session.event.list({ id: session })).some((e) => e.type === "assistant/message" && e.text.includes(second)))
    .toBe(true);
  reconnect!();
  await expect(page.getByTestId("step").filter({ hasText: second }).first()).toBeVisible({ timeout: 10_000 });
});
