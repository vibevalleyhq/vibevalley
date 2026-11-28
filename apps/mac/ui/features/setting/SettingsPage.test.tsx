import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";

import { fakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

async function mountSettings(route: string, locale: "en" | "zh") {
  setLocale(locale);
  const fake = fakeHost(scenarios.typical, { route, locale });
  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pump(app);
  return { app, fake };
}

test("SettingsPage renders Skills and Memory sections directly and searches skills (en)", async () => {
  const { app, fake } = await mountSettings("/settings/skills", "en");
  expect(app.count("id:settings-nav")).toBe(1);
  expect(app.count("id:settings-section-skills")).toBe(1);
  expect(app.count("id:settings-section-memory")).toBe(1);
  expect(app.count("id:settings-skills")).toBe(1);
  expect(app.count("id:skills-book")).toBe(1);

  await app.press("id:settings-section-memory");
  await fake.pumpUntil(app, () => app.count("id:memory-form") === 1);
  expect(app.count("id:settings-memory")).toBe(1);
  expect(app.count("id:memory-form")).toBe(1);

  await app.type("id:settings-search", "skills");
  expect(app.count("id:settings-section-skills")).toBe(1);
  expect(app.count("id:settings-section-general")).toBe(0);
});

test("SettingsPage search finds Memory by external source keyword (en)", async () => {
  const { app, fake } = await mountSettings("/settings/memory", "en");
  await fake.pumpUntil(app, () => app.count("id:memory-form") === 1);
  expect(app.count("id:settings-memory")).toBe(1);
  expect(app.count("id:memory-form")).toBe(1);

  await app.type("id:settings-search", "EverOS");
  expect(app.count("id:settings-section-memory")).toBe(1);
  expect(app.count("id:settings-section-skills")).toBe(0);
});

test("SettingsPage search finds 技能 and 记忆 in Chinese locale", async () => {
  const skillsApp = await mountSettings("/settings/memory", "zh");
  await skillsApp.fake.pumpUntil(skillsApp.app, () => skillsApp.app.count("id:memory-form") === 1);
  expect(skillsApp.app.count("id:settings-memory")).toBe(1);
  expect(skillsApp.app.count("id:memory-form")).toBe(1);

  await skillsApp.app.type("id:settings-search", "技能");
  expect(skillsApp.app.count("id:settings-section-skills")).toBe(1);
  expect(skillsApp.app.count("id:settings-section-memory")).toBe(0);

  const memoryApp = await mountSettings("/settings/skills", "zh");
  await memoryApp.app.type("id:settings-search", "记忆");
  expect(memoryApp.app.count("id:settings-section-memory")).toBe(1);
  expect(memoryApp.app.count("id:settings-section-skills")).toBe(0);
});

test("SettingsPage general and appearance render separate sections with split IA groups (zh & en)", async () => {
  const zh = await mountSettings("/settings/general", "zh");
  expect(zh.app.count("id:desk")).toBe(0);
  const zhTexts = zh.app.texts();
  expect(zhTexts).toContain("个人与项目");
  expect(zhTexts).toContain("连接与集成");
  expect(zhTexts).toContain("数据与关于");
  expect(zhTexts).toContain("调整界面语言与启动默认页面。");
  expect(zhTexts).toContain("语言");
  expect(zhTexts).toContain("对整个 VibeValley");
  expect(zhTexts).toContain("启动");
  expect(zhTexts).toContain("只对这台设备");
  expect(zh.app.count("id:settings-section-profile")).toBe(1);
  expect(zh.app.count("id:settings-section-appearance")).toBe(1);
  expect(zh.app.count("id:settings-section-mcp")).toBe(1);
  expect(zh.app.count("id:settings-section-data")).toBe(1);
  expect(zh.app.count("id:settings-section-about")).toBe(1);
  expect(zh.app.count("id:theme-dark")).toBe(0);

  await zh.app.press("id:settings-section-data");
  await zh.fake.pumpUntil(zh.app, () => zh.app.count("id:data-storage-backend") === 1);
  expect(zh.app.count("id:about-version")).toBe(0);

  await zh.app.press("id:settings-section-about");
  await zh.fake.pumpUntil(zh.app, () => zh.app.count("id:about-version") === 1);
  expect(zh.app.count("id:data-storage-backend")).toBe(0);

  const en = await mountSettings("/settings/general", "en");
  const enTexts = en.app.texts();
  expect(enTexts).toContain("Profile & Projects");
  expect(enTexts).toContain("Connections & Integrations");
  expect(enTexts).toContain("Data & About");
  expect(enTexts).toContain("Configure interface language and startup behavior.");
  expect(enTexts).toContain("Language");
  expect(enTexts).toContain("For all of VibeValley");
  expect(enTexts).toContain("Startup");
  expect(enTexts).toContain("This device only");
  expect(enTexts).toContain("Appearance");

  await en.app.press("id:settings-section-appearance");
  await en.fake.pumpUntil(en.app, () => en.app.count("id:theme-dark") === 1);
  expect(en.app.count("id:motion-off")).toBe(1);
});

test("SettingsPage omits unlabelled lone file icon on /settings/models and /settings/memory", async () => {
  for (const route of ["/settings/models", "/settings/memory"]) {
    const { app, fake } = await mountSettings(route, "en");
    await fake.pump(app);
    const texts = app.texts();
    expect(texts.some((line) => line.includes("Stored in"))).toBe(false);
    expect(app.count("label:Stored in")).toBe(0);
  }
});

test("SkillsPage auto-selects first built-in skill when no installed/own skills exist and avoids mid-text clipping at 900x720", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/settings/skills", locale: "en" });
  const runtimes = (scenarios.typical.responses["runtime.list"] as readonly Record<string, unknown>[]).map((r) => ({
    ...r,
    skills: [],
  }));
  fake.respond("runtime.list", () => runtimes);
  fake.respond("skill.list", () => [
    { id: "review", name: "Code Review", description: "Review changes carefully", body: "# Review", builtIn: true },
    { id: "tdd", name: "Test First", description: "Write failing tests first", body: "# TDD", builtIn: true },
    { id: "docs", name: "Update Docs", description: "Keep subsystem docs synced", body: "# Docs", builtIn: true },
  ]);

  const app = await open("../../app/main.tsx", {
    width: 900,
    height: 720,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:built-in-skill") === 1);

  expect(app.texts()).not.toContain("No skills yet: write one of VibeValley's own, or install some on a runtime and come back.");
  const book = app.layout("id:skills-book")!;
  const builtInBox = app.layout("id:built-in-skills")!;
  expect(app.count("id:skill-entry")).toBe(3);
  expect(builtInBox.y).toBeGreaterThanOrEqual(book.y);
  expect(builtInBox.y + builtInBox.height).toBeLessThanOrEqual(book.y + book.height);
  for (const title of ["Code Review", "Test First", "Update Docs"]) {
    const row = app.layout(`id:skill-entry >> text:${title}`);
    expect(row).not.toBeNull();
    expect(row!.y).toBeGreaterThanOrEqual(book.y);
    expect(row!.y + row!.height).toBeLessThanOrEqual(book.y + book.height);
  }
});

test("ConnectorsPage stacks horizontal selector below xl (< 1280px) so ConnectorCard is not squeezed at 900x720", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/settings/chat/weixin", locale: "en" });
  const app = await open("../../app/main.tsx", {
    width: 900,
    height: 720,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:connector-weixin") === 1);

  const listBox = app.layout("id:connectors")!;
  const cardBox = app.layout("id:connector-weixin")!;
  expect(cardBox.y).toBeGreaterThanOrEqual(listBox.y + listBox.height);
  expect(cardBox.width).toBeGreaterThan(450);
});

test("SettingsPage collapses duplicate voice readiness warnings, omits self-pointing fix link on /settings/providers, and clears nav active state", async () => {
  setLocale("zh");
  const baseSettings = scenarios.typical.responses["setting.get"] as Record<string, unknown>;
  const baseReadiness = baseSettings.readiness as Record<string, unknown>;
  const fake = fakeHost(scenarios.typical, { route: "/settings/voice", locale: "zh" });
  fake.respond("setting.get", {
    ...baseSettings,
    readiness: {
      ...baseReadiness,
      orchestrator: { ready: true },
      live: { ready: false, missing: "mossAccount" },
      vision: { ready: false, missing: "mossAccount" },
      call: { ready: false, missing: "mossAccount" },
    },
  });

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:readiness") === 1);

  // /settings/voice collapses the 3 identical MOSS account warnings into a single concise row.
  expect(app.count("id:readiness-row-lacking")).toBe(1);
  expect(app.count("id:readiness-fix")).toBe(1);
  expect(app.texts()).toContain("MOSS Live、实时视觉、通话：还没有 MOSS 账号");

  // Navigating to /settings/providers omits the redundant self-pointing 去设置 link.
  await app.press("id:readiness-fix");
  await fake.pumpUntil(app, () => app.count("id:settings-providers") === 1);
  expect(app.count("id:readiness-row-ready")).toBe(1);
  expect(app.count("id:readiness-row-lacking")).toBe(1);
  expect(app.count("id:readiness-fix")).toBe(0);
  expect(app.texts()).toContain("通话：还没有 MOSS 账号");

  // Switching away from /settings/providers keeps only the target section selected.
  await app.press("id:settings-section-general");
  await fake.pumpUntil(app, () => app.count("id:settings-general") === 1);
  expect(app.count("id:settings-providers")).toBe(0);
});

test("SettingsPage GitHub section distinguishes Token, gh, and unconfigured states and saves githubToken", async () => {
  setLocale("zh");
  for (const mode of ["token", "gh", "none"] as const) {
    const fake = fakeHost(scenarios.typical, { route: "/settings/github", locale: "zh" });
    fake.respond("github.get", {
      installed: mode === "gh",
      version: mode === "gh" ? "2.62.0" : null,
      loggedIn: mode !== "none",
      account: mode === "none" ? null : "octocat",
      authMode: mode,
      reason: mode === "none" ? "unconfigured" : "",
      checkedAt: SCENARIO_NOW,
    });
    const app = await open("../../app/main.tsx", {
      width: 1200,
      height: 800,
      colorScheme: "light",
      platform: "macos",
      clock: { time: SCENARIO_NOW },
      host: fake.options,
    });
    await fake.pumpUntil(app, () => app.count(`id:github-mode-${mode}`) === 1);
    expect(app.count("id:github-token-form")).toBe(1);
    if (mode !== "none") {
      expect(app.texts()).toContain("octocat");
    }
  }

  const fake = fakeHost(scenarios.typical, { route: "/settings/github", locale: "zh" });
  const baseSettings = scenarios.typical.responses["setting.get"] as Record<string, unknown>;
  fake.respond("github.get", {
    installed: false,
    version: null,
    loggedIn: false,
    account: null,
    authMode: "none",
    reason: "",
    checkedAt: SCENARIO_NOW,
  });
  let savedToken: string | undefined;
  fake.respond("setting.update", (payload: unknown) => {
    const params = payload as { githubToken?: string };
    savedToken = params.githubToken;
    return { ...baseSettings, githubToken: { source: "settings", hint: "…9999" } };
  });
  fake.respond("github.refresh", () => ({
    installed: false,
    version: null,
    loggedIn: true,
    account: "octocat",
    authMode: "token",
    reason: "",
    checkedAt: SCENARIO_NOW + 1,
  }));

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:github-mode-none") === 1 && app.count("id:github-token-form") === 1);

  await app.type("id:github-token >> id:secret", "ghp_testtoken9999");
  await fake.pumpUntil(app, () => app.count("id:github-token-form >> id:save") === 1);
  await app.press("id:github-token-form >> id:save");
  await fake.pumpUntil(app, () => savedToken === "ghp_testtoken9999" && app.count("id:github-mode-token") === 1);
  expect(app.texts()).toContain("octocat");
});

test("SettingsPage splits Model Providers (/settings/providers) and Models & Model Policy (/settings/models) with verify, capability tags, CTA, and scene fallbacks", async () => {
  setLocale("zh");
  const emptyProvider = {
    revision: 0,
    connections: [],
    orchestrator: null,
    polish: null,
    image: null,
    understanding: null,
    speech: null,
    speakers: null,
    voiceDesign: null,
    transcription: null,
    live: null,
    vision: null,
    scenePolicies: [],
  };
  let currentProvider: Record<string, unknown> = emptyProvider;
  const fake = fakeHost(scenarios.typical, { route: "/settings/models", locale: "zh" });
  fake.respond("provider.get", () => currentProvider);
  fake.respond("provider.update", (payload: unknown) => {
    const input = payload as {
      revision: number;
      connections: { id: string; name: string; adapter: string; enabled: boolean; key?: string | null }[];
      orchestrator: unknown;
      polish: unknown;
      speech: unknown;
      transcription: unknown;
      live: unknown;
      vision: unknown;
      image: unknown;
      understanding: unknown;
      speakers: unknown;
      voiceDesign: unknown;
      scenePolicies: unknown[];
    };
    const prevConns = currentProvider.connections as {
      id: string;
      name: string;
      adapter: string;
      enabled: boolean;
      key: { source: string | null; hint?: string };
      models: unknown[];
      verification?: unknown;
    }[];
    currentProvider = {
      ...input,
      revision: input.revision + 1,
      connections: input.connections.map((c) => {
        const prev = prevConns.find((p) => p.id === c.id);
        return {
          id: c.id,
          name: c.name,
          adapter: c.adapter,
          enabled: c.enabled,
          key: typeof c.key === "string" ? { source: "settings", hint: `…${c.key.slice(-4)}` } : (prev?.key ?? { source: null }),
          models: prev?.models ?? [],
          ...(prev?.verification !== undefined ? { verification: prev.verification } : {}),
        };
      }),
    };
    return currentProvider;
  });
  fake.respond("provider.verify", (payload: unknown) => {
    const req = payload as { connection: string; revision: number };
    const prevConns = currentProvider.connections as {
      id: string;
      name: string;
      adapter: string;
      enabled: boolean;
      key: { source: string | null; hint?: string };
      models: unknown[];
    }[];
    currentProvider = {
      ...currentProvider,
      revision: req.revision + 1,
      connections: prevConns.map((c) =>
        c.id === req.connection
          ? {
              ...c,
              models: [
                { id: "deepseek-chat", owner: "deepseek", capabilities: ["chat"] },
                { id: "deepseek-reasoner", owner: "deepseek", capabilities: ["chat"] },
              ],
              verification: { status: "verified", checkedAt: SCENARIO_NOW },
            }
          : c,
      ),
    };
    return currentProvider;
  });

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:models-empty-cta") === 1);
  expect(app.count("id:settings-section-providers")).toBe(1);
  expect(app.count("id:settings-section-models")).toBe(1);

  // Clicking CTA on empty Models & Model Policy navigates to /settings/providers.
  await app.press("id:models-go-providers");
  await fake.pumpUntil(app, () => app.count("id:settings-providers") === 1 && app.count("id:provider-card-deepseek") === 1);
  expect(app.count("id:provider-card-moss")).toBe(1);
  expect(app.count("id:provider-card-minimax")).toBe(0);
  expect(app.count("id:provider-card-openai")).toBe(0);

  // Enter DeepSeek API key and click Save & Verify -> auto-fetches models with capability tags.
  await app.type("id:provider-key-deepseek >> id:secret", "sk-deepseek-9999");
  await fake.pump(app);
  await app.press("id:provider-verify-deepseek");
  await fake.pumpUntil(app, () => app.count("id:provider-model-chip-deepseek-chat") === 1);
  expect(fake.calls.some((c) => c.op === "provider.update")).toBe(true);
  expect(fake.calls.some((c) => c.op === "provider.verify")).toBe(true);
  expect(app.texts()).toContain("Chat 对话");

  // Switch back to Models & Model Policy; empty CTA disappears and DeepSeek models are selectable for Chat scenes.
  await app.press("id:settings-section-models");
  await fake.pumpUntil(app, () => app.count("id:models-policy-form") === 1 && app.count("id:models-empty-cta") === 0);
  await app.press("id:scene-select-orchestrator-trigger");
  await fake.pumpUntil(app, () => app.count("text:deepseek-chat") >= 1);
  await app.press("text:deepseek-chat");
  await fake.pumpUntil(app, () => app.count("id:scene-fallback-toggle-orchestrator") === 1);
  await app.press("id:scene-fallback-toggle-orchestrator");
  await fake.pumpUntil(app, () => app.count("id:scene-fallback-add-orchestrator-trigger") === 1);
  await app.press("id:scene-fallback-add-orchestrator-trigger");
  await fake.pumpUntil(app, () => app.count("text:deepseek-reasoner") >= 1);
  await app.press("text:deepseek-reasoner >> nth=1");
  await fake.pumpUntil(app, () => app.count("id:scene-fallback-item-orchestrator-0") === 1);

  await app.press("id:save");
  await fake.pumpUntil(app, () => (currentProvider.orchestrator as { model?: string } | null)?.model === "deepseek-chat");
  expect((currentProvider.scenePolicies as { scene: string; fallbacks: { model: string }[] }[])[0]?.fallbacks[0]?.model).toBe("deepseek-reasoner");
});
