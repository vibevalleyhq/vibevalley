import type { Agent, VibeValleyApi } from "@vibevalley/protocol";
import { expect, test } from "./fixtures";

const profile: Agent = {
  id: "",
  name: "轨迹测试员",
  role: "",
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
  const issue = await api.issue.create({ title: "先记下第一轮", project: project.name, assignee: agent.id });
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
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  await expect(page.getByRole("button", { name: "工单 先记下第一轮", exact: true })).toBeVisible();
  await expect.poll(() => connections).toBeGreaterThan(1);

  await api.issue.comment.create({ id: issue.id, text: "断线时写下第二轮" });
  await expect
    .poll(async () => (await api.session.event.list({ id: session })).some((e) => e.type === "assistant/message" && e.text.includes("断线时写下第二轮")))
    .toBe(true);
  reconnect!();
  await expect(page.getByRole("button", { name: /带话 .*断线时写下第二轮/ })).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: test.info().outputPath("reconnected-trajectory.png") });
});
