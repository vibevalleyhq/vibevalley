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
  const zhTexts = zh.app.texts();
  expect(zhTexts).toContain("个人与工作区");
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
  expect(enTexts).toContain("Profile & Workspace");
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
