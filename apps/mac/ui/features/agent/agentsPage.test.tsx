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
    fixHref: "/settings/models",
  });
  expect(localizeAgentProblem("no API key is set for the model")).toEqual({
    text: "还没填模型 API 密钥",
    fixHref: "/settings/models",
  });
  expect(localizeAgentProblem("custom error")).toEqual({ text: "custom error" });

  setLocale("en");
  expect(localizeAgentProblem("no DeepSeek API key is set")).toEqual({
    text: "No DeepSeek key yet",
    fixHref: "/settings/models",
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
  expect(app.count("id:new-orchestrator")).toBe(1);
  expect(app.count("id:new-agent")).toBe(1);
  expect(app.texts()).toContain("团队");
  expect(app.texts()).toContain("模板库");

  // Localized Chinese error text replaces raw English, paired with a direct 去设置 link.
  expect(app.texts()).toContain("派不出去：还没填 DeepSeek 的钥匙");
  expect(app.texts().some((line) => line.includes("no DeepSeek API key is set"))).toBe(false);
  expect(app.count("id:agent-card-fix-laozhou")).toBe(1);

  // Template cards render description below header, preview toggle button, and concise built-in runtime label.
  expect(app.count("id:template-look")).toBeGreaterThan(0);
  expect(app.texts()).toContain("跑在内置引擎");
  expect(app.texts().some((line) => line.includes("跑在 VibeValley 自己的 agent"))).toBe(false);

  // Clicking 去设置 navigates directly to /settings/models.
  await app.press("id:agent-card-fix-laozhou");
  await fake.pumpUntil(app, () => app.count("id:settings-models") === 1);
  expect(app.count("id:settings-models")).toBe(1);
});
