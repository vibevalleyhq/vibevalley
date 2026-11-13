// The agents, templates, runtimes and repos pages through the bridge, the
// Rust side played by fakeHost on the workbench fixture (vv/fixtures/agents.ts).
// Pictures come from agents.shots.test.tsx.
import "../polyfill";
import { expect, open, test } from "nsh/test";

import { responses, state } from "../fixtures/workbench";
import { fakeHost } from "./fakeHost";

async function start(route: string, options: { width?: number } = {}) {
  const fake = fakeHost({ state, responses }, { route });
  const app = await open("./main.tsx", { width: options.width ?? 1200, height: 760, colorScheme: "light", platform: "macos", host: fake.options });
  await fake.pump(app);
  await fake.pump(app);
  return { app, fake };
}

const ops = (fake: { calls: { op: string }[] }) => fake.calls.map((c) => c.op);

test("the agents page: orchestrators and helpers as cards", async () => {
  const { app, fake } = await start("/agents");
  expect(app.count("id:agents-page")).toBe(1);
  for (const s of ["老村长", "老周", "小林", "阿花", "写接口、改 server、跑测试"]) expect(app.texts()).toContain(s);
  expect(app.count("id:agent-card-laozhou")).toBe(1);
  expect(app.count("id:agent-card-orchestrator")).toBe(1);
  expect(app.count("id:new-orchestrator")).toBe(1);
  // The disabled one shows what blocks it.
  expect(app.count("id:agent-card-error")).toBe(1);
  expect(ops(fake)).toContain("agent.list");
  expect(ops(fake)).toContain("runtime.list");
});

test("a helper's profile opens from its card, its tabs switch", async () => {
  const { app, fake } = await start("/agents");
  await app.press("id:agent-card-laozhou");
  await fake.pump(app);
  expect(app.count("id:agent-page")).toBe(1);
  expect(app.count("id:profile-saved")).toBe(1);
  expect(app.value("id:agent-name")).toBe("老周");
  expect(app.count("id:from-template")).toBe(1);
  // The template has a newer version than the one installed.
  expect(app.count("id:template-update")).toBe(1);
  await app.type("id:agent-name", "老周二号");
  expect(app.count("id:profile-dirty")).toBe(1);
  await app.press("id:tab-runtime");
  expect(app.count("id:runtime-claude")).toBe(1);
  expect(app.texts()).toContain("Claude Code");
  await app.press("id:tab-skills");
  expect(app.count("id:skill-review")).toBe(1);
  await app.press("id:tab-env");
  expect(app.count("id:open-terminal")).toBe(1);
});

test("a helper's trajectories: the helpers it sent, the picked one's steps", async () => {
  const { app, fake } = await start("/agents/laozhou");
  await app.press("id:tab-trajectories");
  await fake.pump(app);
  expect(app.count("id:trajectories")).toBe(1);
  expect(app.count("id:sent-session")).toBe(2);
  await fake.pump(app);
  expect(app.count("id:trajectory")).toBe(1);
  expect(ops(fake)).toContain("session.event.list");
});

test("the orchestrator's page: its trajectory, marked wrong where it went wrong", async () => {
  const { app, fake } = await start("/orchestrator");
  expect(app.count("id:orchestrator-page")).toBe(1);
  expect(app.count("id:orchestrator-memory")).toBe(1);
  expect(app.count("id:memory-m-note-1")).toBe(1);
  await app.press("id:tab-trajectory");
  await fake.pump(app);
  await fake.pump(app);
  expect(app.count("id:trajectory")).toBe(1);
  expect(app.count("id:mark-wrong")).toBeGreaterThan(0);
});

test("a new helper starts unsaved", async () => {
  const { app } = await start("/agents/new?runtime=codex");
  expect(app.count("id:profile-new")).toBe(1);
  expect(app.count("id:agent-page")).toBe(1);
});

test("an unknown profile says so", async () => {
  const { app } = await start("/agents/nobody");
  expect(app.count("id:agent-missing")).toBe(1);
});

test("the orchestrator's profile", async () => {
  const { app } = await start("/agents/orchestrator");
  expect(app.count("id:orchestrator-profile")).toBe(1);
  expect(app.count("id:look-foreman")).toBe(1);
  // The default orchestrator cannot be removed.
  expect(app.count("id:delete")).toBe(0);
});

test("templates", async () => {
  const { app, fake } = await start("/agents/templates");
  expect(app.count("id:templates-page")).toBe(1);
  expect(app.count("id:template-backend")).toBe(1);
  expect(app.count("id:template-foreman")).toBe(1);
  expect(ops(fake)).toContain("agent.template.list");
  expect(ops(fake)).toContain("skill.list");
});

test("runtimes: the list and one runtime's detail", async () => {
  const { app, fake } = await start("/runtimes");
  expect(app.count("id:runtimes-page")).toBe(1);
  for (const s of ["Claude Code", "Codex", "OpenCode", "VibeValley"]) expect(app.texts()).toContain(s);
  expect(app.count("id:runtime-detail")).toBe(1);
  expect(app.count("id:runtime-models")).toBe(1);
  expect(app.count("id:runtime-terminal")).toBe(1);
  await app.press("id:list-row-opencode");
  await fake.pump(app);
  expect(app.count("id:runtime-terminal")).toBe(0);
});

test("repos: the list, then one repo with a terminal at its folder", async () => {
  const { app, fake } = await start("/repos");
  expect(app.count("id:repos-page")).toBe(1);
  expect(app.count("id:repos-map")).toBe(1);
  await app.press("id:list-row-vibevalley");
  await fake.pump(app);
  await fake.pump(app);
  expect(app.count("id:repo-overview")).toBe(1);
  expect(app.count("id:repo-calendar")).toBe(1);
  expect(app.count("id:repo-hands")).toBe(1);
  expect(ops(fake)).toContain("repo.activity.get");
  await app.press("id:repo-terminal");
  await fake.pump(app);
  const opened = fake.calls.find((c) => c.op === "host.openTerminal");
  expect((opened?.payload as { cwd?: string } | undefined)?.cwd).toBe("/Users/farmer/code/vibevalley");
});

test("the new repo dialog", async () => {
  const { app } = await start("/repos");
  await app.press("id:new-repo");
  expect(app.count("id:repo-name")).toBe(1);
  await app.press("id:cancel");
  expect(app.count("id:repo-name")).toBe(0);
});

test("narrow", async () => {
  const { app } = await start("/agents", { width: 560 });
  expect(app.count("id:agents-page")).toBe(1);
});
