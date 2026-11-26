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

test("SettingsPage general renders symmetric left section titles paired with scope notes (zh & en)", async () => {
  const zh = await mountSettings("/settings/general", "zh");
  const zhTexts = zh.app.texts();
  expect(zhTexts).toContain("工作区");
  expect(zhTexts).toContain("语音与连接");
  expect(zhTexts).toContain("调整语言、启动方式、主题与界面显示偏好。");
  expect(zhTexts).toContain("语言");
  expect(zhTexts).toContain("对整个 VibeValley");
  expect(zhTexts).toContain("启动");
  expect(zhTexts).toContain("只对这台设备");
  expect(zhTexts).toContain("外观");

  const en = await mountSettings("/settings/general", "en");
  const enTexts = en.app.texts();
  expect(enTexts).toContain("Workspace");
  expect(enTexts).toContain("Voice & Connections");
  expect(enTexts).toContain("Configure language, startup behavior, theme, and display preferences.");
  expect(enTexts).toContain("Language");
  expect(enTexts).toContain("For all of VibeValley");
  expect(enTexts).toContain("Startup");
  expect(enTexts).toContain("This device only");
  expect(enTexts).toContain("Appearance");
});
