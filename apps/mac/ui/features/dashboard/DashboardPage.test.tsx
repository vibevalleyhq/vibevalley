import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";

import { fakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

test("DashboardPage renders profile overview, switches to hosted /dashboard/runs, and renders /runs seamlessly", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/dashboard", locale: "en" });
  const baseSettings = scenarios.typical.responses["setting.get"] as Record<string, unknown>;
  fake.respond("setting.get", {
    ...baseSettings,
    profile: { displayName: "Ada", tagline: "Keeping the board green", avatarPreset: "monogram" },
  });

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });

  await fake.pumpUntil(app, () => app.count("id:dashboard-overview") === 1);
  expect(app.count("id:dashboard-header")).toBe(1);
  expect(app.count("id:desk")).toBe(0);
  expect(app.shows("id:dashboard-profile-card >> text:Ada")).toBe(true);
  expect(app.shows("id:dashboard-profile-card >> text:Keeping the board green")).toBe(true);
  expect(app.count("id:dashboard-stat-working")).toBe(1);
  expect(app.count("id:dashboard-stat-waiting")).toBe(1);
  expect(app.count("id:dashboard-pulse")).toBe(1);
  expect(app.count("id:dashboard-pending")).toBe(1);
  expect(app.count("id:dashboard-recent-runs")).toBe(1);
  expect(app.count("id:dashboard-quick-mcp")).toBe(1);

  await app.press("id:dashboard-tabs-runs");
  await fake.pumpUntil(app, () => app.count("id:runs-page") === 1);
  expect(app.count("id:dashboard-header")).toBe(1);
  expect(app.count("id:dashboard-overview")).toBe(0);

  await app.press("id:dashboard-tabs-overview");
  await fake.pumpUntil(app, () => app.count("id:dashboard-overview") === 1);
  expect(app.count("id:runs-page")).toBe(0);

  await app.host.send("route", "/runs");
  await fake.pumpUntil(app, () => app.count("id:runs-page") === 1);
  expect(app.count("id:dashboard-page")).toBe(1);
  expect(app.count("id:dashboard-header")).toBe(1);
});

test("DashboardPage renders Quick Navigation in a 2-column grid without narrow 4-col description truncation", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/dashboard", locale: "en" });
  const app = await open("../../app/main.tsx", {
    width: 900,
    height: 720,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });

  await fake.pumpUntil(app, () => app.count("id:dashboard-quick-mcp") === 1);
  const issuesBox = app.layout("id:dashboard-quick-issues")!;
  const chatBox = app.layout("id:dashboard-quick-chat")!;
  const farmBox = app.layout("id:dashboard-quick-farm")!;
  const mcpBox = app.layout("id:dashboard-quick-mcp")!;

  expect(issuesBox.y).toBe(chatBox.y);
  expect(farmBox.y).toBeGreaterThan(issuesBox.y);
  expect(mcpBox.y).toBe(farmBox.y);
  expect(issuesBox.width).toBeGreaterThan(300);
  expect(mcpBox.width).toBeGreaterThan(300);
});
