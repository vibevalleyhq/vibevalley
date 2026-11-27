import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";

import { fakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

test("ProfileSettingsPage edits name, tagline, preset, uploads custom avatar via pickFile, and saves profile", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/settings/profile", locale: "en", connectionMode: "embedded" });
  fake.respond("host.pickFile", () => ({ path: "/tmp/me.png", name: "me.png", type: "image/png" }));
  fake.respond("attachment.importPath", () => ({
    id: "att-avatar-1",
    name: "me.png",
    type: "image/png",
    size: 1024,
  }));
  fake.respond("attachment.file", () => ({ path: "/tmp/att-avatar-1.png", type: "image/png", name: "me.png" }));

  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });

  await fake.pumpUntil(app, () => app.count("id:profile-settings-page") === 1);

  await app.type("id:profile-display-name", "Lucas");
  await app.type("id:profile-tagline", "Papertrails architect");
  expect(app.shows("id:profile-preview >> text:Lucas")).toBe(true);
  expect(app.shows("id:profile-preview >> text:Papertrails architect")).toBe(true);

  await app.press("id:profile-avatar-upload");
  await fake.pumpUntil(app, () => app.count("id:profile-avatar-clear") === 1);
  expect(fake.calls.some((c) => c.op === "host.pickFile")).toBe(true);
  expect(fake.calls.find((c) => c.op === "attachment.importPath")?.payload).toMatchObject({ path: "/tmp/me.png" });

  await app.press("id:save");
  await fake.pump(app);
  const update = fake.calls.find((c) => c.op === "setting.update")?.payload as { profile?: Record<string, unknown> } | undefined;
  expect(update?.profile).toEqual({
    displayName: "Lucas",
    tagline: "Papertrails architect",
    avatarAttachmentId: "att-avatar-1",
    avatarPreset: "user",
  });

  await app.press("id:profile-preset-monogram");
  expect(app.count("id:profile-avatar-clear")).toBe(0);
  await app.press("id:save");
  await fake.pump(app);
  const secondUpdate = fake.calls.findLast((c) => c.op === "setting.update")?.payload as { profile?: Record<string, unknown> } | undefined;
  expect(secondUpdate?.profile).toEqual({
    displayName: "Lucas",
    tagline: "Papertrails architect",
    avatarAttachmentId: "",
    avatarPreset: "monogram",
  });
});

test("ProfileSettingsPage wraps avatar presets cleanly within container at 900x720 without half-clipping", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/settings/profile", locale: "en", connectionMode: "embedded" });
  const app = await open("../../app/main.tsx", {
    width: 900,
    height: 720,
    colorScheme: "light",
    platform: "macos",
    locale: "en-US",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:profile-settings-page") === 1);

  const pageBox = app.layout("id:profile-settings-page")!;
  const monogram = app.layout("id:profile-preset-monogram")!;
  expect(monogram.x).toBeGreaterThanOrEqual(pageBox.x);
  expect(monogram.x + monogram.width).toBeLessThanOrEqual(pageBox.x + pageBox.width);

  for (const preset of ["user", "avatar-architect", "avatar-builder", "avatar-reviewer", "avatar-tester", "avatar-designer"]) {
    const box = app.layout(`id:profile-preset-${preset}`);
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(pageBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(pageBox.x + pageBox.width);
    }
  }
});
