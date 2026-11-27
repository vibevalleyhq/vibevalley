import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Agent } from "@vibevalley/protocol";

import { fakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";
import { assignWorkerAvatars, defaultWorkerAvatar, withDefaultWorkerAvatar } from "./AgentLook";
import { localizeAgentProblem } from "./readiness";

const baseLook: Agent["look"] = {
  species: "fox",
  outfit: "farmer",
  orchestrator: null,
  build: "biped",
  head: "rounded",
  body: "",
  trim: "",
  hat: "",
  eye: "",
};

test("assignWorkerAvatars gives deterministic distinct Papertrails avatars and respects explicit choices", () => {
  const workers = [
    { id: "claude", name: "Claude Code", look: { ...baseLook } },
    { id: "codex", name: "Codex", look: { ...baseLook } },
    { id: "vibevalley", name: "VibeValley", look: { ...baseLook } },
    { id: "codebuddy", name: "CodeBuddy", look: { ...baseLook } },
    { id: "custom-explicit", name: "Explicit", look: { ...baseLook, avatar: "avatar-designer" } },
  ];

  const assigned = assignWorkerAvatars(workers);
  const resolved = workers.map((w) => withDefaultWorkerAvatar(w, assigned.get(w.id)).avatar);
  expect(resolved[4]).toBe("avatar-designer");
  expect(new Set(resolved).size).toBe(workers.length);
  expect(defaultWorkerAvatar("claude")).toBe(defaultWorkerAvatar("claude"));
});

test("localizeAgentProblem translates raw DeepSeek and generic API key errors with settings link", () => {
  setLocale("zh");
  expect(localizeAgentProblem("no DeepSeek API key is set")).toEqual({
    text: "还没填 DeepSeek 的钥匙",
    fixHref: "/settings/providers",
  });
  expect(localizeAgentProblem("no API key is set for the model")).toEqual({
    text: "还没填模型 API 密钥",
    fixHref: "/settings/providers",
  });
  expect(localizeAgentProblem("custom error")).toEqual({ text: "custom error" });

  setLocale("en");
  expect(localizeAgentProblem("no DeepSeek API key is set")).toEqual({
    text: "No DeepSeek key yet",
    fixHref: "/settings/providers",
  });
});

test("AgentsPage uses unified top bar, localizes API-key readiness errors with clickable 去设置 link, and renders full-width template descriptions", async () => {
  setLocale("zh");
  const fake = fakeHost(scenarios.typical, { route: "/agents", locale: "zh" });
  fake.respond("agent.validate", () => [
    {
      id: "laozhou",
      problems: [{ field: "runtime", level: "error", text: "no DeepSeek API key is set" }],
    },
  ]);

  const app = await open("../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:agent-card-error") === 1);

  // Single unified toolbar instead of a two-tier <Desk> + toolbar stack.
  expect(app.count("id:desk")).toBe(0);
  expect(app.count("id:agents-toolbar")).toBe(1);
  expect(app.count("id:open-templates")).toBe(1);
  expect(app.count("id:gallery-manage-templates")).toBe(0);
  expect(app.count("id:new-orchestrator")).toBe(1);
  expect(app.count("id:new-agent")).toBe(1);
  expect(app.texts()).toContain("队友");
  expect(app.texts()).toContain("模板库");

  // Localized Chinese error text replaces raw English, paired with a direct 去设置 link.
  expect(app.texts()).toContain("派不出去：还没填 DeepSeek 的钥匙");
  expect(app.texts().some((line) => line.includes("no DeepSeek API key is set"))).toBe(false);
  expect(app.count("id:agent-card-fix-laozhou")).toBe(1);

  // Starter templates collapse by default when agents exist, and expand cleanly on toggle.
  expect(app.count("id:template-look")).toBe(0);
  await app.press("id:agents-templates-toggle");
  await fake.pumpUntil(app, () => app.count("id:template-look") > 0);
  expect(app.texts()).toContain("跑在内置环境");
  expect(app.texts().some((line) => line.includes("跑在 VibeValley 自己的 agent"))).toBe(false);

  // Clicking 去设置 navigates directly to /settings/providers.
  await app.press("id:agent-card-fix-laozhou");
  await fake.pumpUntil(app, () => app.count("id:settings-providers") === 1);
  expect(app.count("id:settings-providers")).toBe(1);
});

test("AgentPage avatar picker has unique labels for every role avatar and Stage omits redundant name/duty pill", async () => {
  setLocale("zh");
  const fake = fakeHost(scenarios.typical, { route: "/agents/laozhou", locale: "zh" });
  const app = await open("../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:agent-avatar-picker") === 1 && app.count("id:agent-stage") === 1);

  const expectedLabels = [
    "默认小动物",
    "全能主助手",
    "全栈工程师",
    "系统架构师",
    "前端工程师",
    "后端工程师",
    "代码审查员",
    "测试工程师",
    "UI/UX 设计师",
    "产品经理",
    "技术调研员",
    "技术文档师",
    "数据看板师",
    "演示汇报师",
    "素材收集员",
  ];
  for (const label of expectedLabels) {
    expect(app.shows(`id:agent-avatar-picker >> text:${label}`)).toBe(true);
  }
  expect(app.texts().filter((label) => label === "系统架构师").length).toBe(1);

  expect(app.shows("id:agent-stage >> text:老周")).toBe(false);
});

test("AgentsPage keeps primary + New CTA unclipped at 900x720 by collapsing secondary links into overflow menu", async () => {
  for (const locale of ["en", "zh"] as const) {
    setLocale(locale);
    const fake = fakeHost(scenarios.typical, { route: "/agents", locale });
    const app = await open("../../app/main.tsx", {
      width: 900,
      height: 720,
      colorScheme: "light",
      platform: "macos",
      clock: { time: SCENARIO_NOW },
      host: fake.options,
    });
    await fake.pumpUntil(app, () => app.count("id:new-agent") === 1);

    expect(app.count("id:agents-more")).toBe(1);
    expect(app.count("id:open-templates")).toBe(0);
    expect(app.count("id:new-orchestrator")).toBe(0);

    const toolbar = app.layout("id:agents-toolbar")!;
    const newAgent = app.layout("id:new-agent")!;
    const more = app.layout("id:agents-more")!;
    const roleFilter = app.layout("id:agents-role-filter")!;

    expect(newAgent.x + newAgent.width).toBeLessThanOrEqual(900 - 12);
    expect(newAgent.y + newAgent.height).toBeLessThanOrEqual(toolbar.y + toolbar.height + 1);
    expect(roleFilter.x + roleFilter.width).toBeLessThanOrEqual(more.x);
    expect(more.x + more.width).toBeLessThanOrEqual(newAgent.x);
  }
});

test("AgentsPage renders O-XX/W-XX codes, Managed vs External mode badges, and searches by code without showing OAR errors on external teammates", async () => {
  setLocale("zh");
  const baseAgents = scenarios.typical.responses["agent.list"] as Agent[];
  const externalTeammate: Agent = {
    ...baseAgents[1],
    id: "antigravity-ide",
    code: "W-04",
    name: "Antigravity",
    role: "worker",
    mode: "external",
    runtime: "antigravity",
    enabled: true,
    look: { ...baseLook, avatar: "avatar-architect" },
  };
  const fake = fakeHost(scenarios.typical, { route: "/agents", locale: "zh" });
  fake.respond("agent.list", () => [...baseAgents, externalTeammate]);
  fake.respond("agent.validate", () => [
    { id: "laozhou", problems: [{ field: "runtime", level: "error", text: "no DeepSeek API key is set" }] },
    { id: "antigravity-ide", problems: [{ field: "runtime", level: "error", text: "ignored for external" }] },
  ]);

  const app = await open("../../app/main.tsx", {
    width: 1280,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.texts().includes("Antigravity"));

  expect(app.texts()).toContain("O-01");
  expect(app.texts()).toContain("W-01");
  expect(app.texts()).toContain("W-04");
  expect(app.texts()).toContain("本机调度");
  expect(app.texts()).toContain("外部接入");
  expect(app.count("id:agent-card-error")).toBe(1);

  await app.type("id:agents-search", "W-04");
  await fake.pump(app);
  expect(app.texts()).toContain("Antigravity");
  expect(app.texts()).not.toContain("老周");
});
