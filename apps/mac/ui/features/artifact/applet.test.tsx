import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { BizCode } from "@vibevalley/protocol/api";

import { responses as artifactResponses } from "../../fixtures/artifacts";
import { fakeHost, type FakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

async function mountRoute(route: string, configure?: (fake: FakeHost) => void, params?: Record<string, unknown>) {
  const fake = fakeHost(scenarios.typical, { route, locale: "en", ...params });
  for (const [op, answer] of Object.entries(artifactResponses)) {
    fake.respond(op, answer);
  }
  configure?.(fake);
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

test("StandaloneArtifactPage renders chromeless artifact view without workbench chrome", async () => {
  setLocale("en");
  const { app, fake } = await mountRoute("/standalone/artifact/art-launch-board");

  await fake.pumpUntil(app, () => app.count("id:standalone-artifact-title") === 1);
  expect(app.count("id:standalone-artifact-page")).toBe(1);
  expect(app.count("id:standalone-artifact-header")).toBe(1);
  expect(app.count("id:artifact-collab-bar")).toBe(0);
  expect(app.count("id:artifact-view-mode")).toBe(1);
  expect(app.count("id:rail")).toBe(0);
  expect(app.count("id:artifacts")).toBe(0);
  expect(app.count("id:content-sidebar")).toBe(0);

  expect(app.texts()).toContain("产品发布时间线");
  expect(app.texts()).toContain(t("web.artifact.types.whiteboard"));
  expect(app.count("id:standalone-artifact-type")).toBe(1);
  expect(app.count("id:standalone-artifact-version")).toBe(1);
  expect(app.count("id:standalone-artifact-error")).toBe(0);
  expect(app.count("id:standalone-artifact-empty")).toBe(0);
});

test("StandaloneArtifactPage displays loading skeleton and missing error state cleanly", async () => {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/standalone/artifact/art-launch-board", locale: "en" });
  const app = await open("../../app/main.tsx", {
    width: 1000,
    height: 700,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: {
      ...fake.options,
      handlers: {
        ...fake.options.handlers,
        action: (data: unknown) => {
          const a = data as { type?: string; op?: string };
          if (a.type === "call" && a.op === "artifact.get") return null;
          const base = fake.options.handlers?.action;
          return typeof base === "function" ? base(data) : null;
        },
      },
    },
  });
  await fake.pump(app);
  const clock = app.clock;
  if (!clock) throw new Error("virtual clock required");
  await clock.fastForward(200);
  await fake.pump(app);
  expect(app.count("id:standalone-artifact-skeleton")).toBe(1);

  const missing = await mountRoute("/standalone/artifact/does-not-exist", (f) => {
    f.respond("artifact.get", () => ({ bizCode: BizCode.ArtifactNotFound, message: "Artifact not found" }));
  });
  await missing.fake.pumpUntil(missing.app, () => missing.app.count("id:standalone-artifact-empty") === 1);
  expect(missing.app.count("id:standalone-artifact-error")).toBe(1);
  expect(missing.app.texts()).toContain("Artifact not found");
  expect(missing.app.texts()).toContain(t("web.artifact.standalone.missing"));
});

test("InstallAppletModal installs, updates, opens, and uninstalls applet with live toolbar badge", async () => {
  setLocale("en");
  const { app, fake } = await mountRoute("/artifacts/art-launch-board");

  await fake.pumpUntil(app, () => app.count("id:artifact-install-applet") === 1);
  expect(app.count("id:artifact-install-applet-badge")).toBe(0);

  await app.press("id:artifact-install-applet");
  await fake.pumpUntil(app, () => app.count("id:install-applet-modal") === 1);
  expect(app.value("id:install-applet-name")).toBe("产品发布时间线");
  expect(app.count("id:install-applet-open")).toBe(0);
  expect(app.count("id:install-applet-uninstall")).toBe(0);
  expect(app.texts()).toContain(t("web.artifact.applet.statusNotInstalled"));

  await app.clear("id:install-applet-name");
  await app.press("id:install-applet-submit");
  await fake.pumpUntil(app, () => app.count("id:install-applet-error") === 1);
  expect(app.texts()).toContain(t("web.artifact.applet.nameRequired"));

  await app.type("id:install-applet-name", "Launch Board");
  await app.press("id:install-applet-always-on-top");
  await app.press("id:install-applet-submit");

  await fake.pumpUntil(app, () => app.count("id:install-applet-meta") === 1);
  expect(fake.calls.findLast((c) => c.op === "host.appletInstall")?.payload).toEqual({
    artifactId: "art-launch-board",
    artifactType: "whiteboard",
    appName: "Launch Board",
    alwaysOnTop: true,
  });
  expect(app.texts()).toContain(t("web.artifact.applet.statusInstalled"));
  expect(app.texts()).toContain("dev.vibevalley.applet.art-launch-board");
  expect(app.texts()).toContain("/Users/demo/Applications/VibeValley Apps/Launch Board.app");
  expect(app.texts()).toContain(t("web.artifact.applet.reinstall"));
  expect(app.count("id:install-applet-open")).toBe(1);
  expect(app.count("id:install-applet-uninstall")).toBe(1);
  expect(app.count("id:artifact-install-applet-badge")).toBe(1);

  await app.press("id:install-applet-open");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "host.appletOpen"));
  expect(fake.calls.findLast((c) => c.op === "host.appletOpen")?.payload).toEqual({ artifactId: "art-launch-board" });

  await app.press("id:install-applet-uninstall");
  await fake.pumpUntil(app, () => app.count("id:install-applet-meta") === 0);
  expect(fake.calls.findLast((c) => c.op === "host.appletUninstall")?.payload).toEqual({ artifactId: "art-launch-board" });
  expect(app.count("id:install-applet-open")).toBe(0);
  expect(app.count("id:install-applet-uninstall")).toBe(0);
  expect(app.count("id:artifact-install-applet-badge")).toBe(0);
});

test("InstallAppletModal surfaces install errors and wires ArtifactCanvas button when host.applet exists", async () => {
  setLocale("en");
  const canvas = await mountRoute("/chat?artifact=art-launch-board", (f) => {
    f.respond("host.appletInstall", () => ({ bizCode: BizCode.Refused, message: "codesign failed" }));
  });

  await canvas.fake.pumpUntil(canvas.app, () => canvas.app.count("id:artifact-canvas-install-applet") === 1);
  await canvas.app.press("id:artifact-canvas-install-applet");
  await canvas.fake.pumpUntil(canvas.app, () => canvas.app.count("id:install-applet-modal") === 1);
  await canvas.app.press("id:install-applet-submit");
  await canvas.fake.pumpUntil(canvas.app, () => canvas.app.count("id:install-applet-error") === 1);
  expect(canvas.app.texts()).toContain("codesign failed");

  const browser = await mountRoute("/artifacts/art-launch-board", undefined, { view: undefined });
  await browser.fake.pumpUntil(browser.app, () => browser.app.count("id:artifact-header") === 1);
  expect(browser.app.count("id:artifact-install-applet")).toBe(0);
});

test("Content Hub provides per-card install-as-app actions and dedicated Installed Apps bucket", async () => {
  setLocale("en");
  const { app, fake } = await mountRoute("/library");

  await fake.pumpUntil(app, () => app.count("id:content-nav-apps") === 1 && app.count("id:library-artifact-art-launch-board") === 1);
  expect(app.count("id:library-artifact-install-app-art-launch-board")).toBe(1);
  expect(app.count("id:library-artifact-install-app-art-login")).toBe(1);

  await app.press("id:content-nav-apps");
  await fake.pumpUntil(app, () => app.count("id:library-apps-empty") === 1);
  expect(app.texts()).toContain(t("web.library.content.installedAppsEmpty"));

  await app.press("id:content-nav-recent");
  await fake.pumpUntil(app, () => app.count("id:library-artifact-install-app-art-launch-board") === 1);

  await app.press("id:library-artifact-install-app-art-launch-board");
  await fake.pumpUntil(app, () => app.count("id:install-applet-modal") === 1);
  await app.press("id:install-applet-submit");
  await fake.pumpUntil(app, () => app.count("id:install-applet-meta") === 1);
  await app.keyboard.press("escape");
  await fake.pumpUntil(app, () => app.count("id:install-applet-modal") === 0);

  await app.press("id:content-nav-apps");
  await fake.pumpUntil(app, () => app.count("id:library-artifact-art-launch-board") === 1);
  expect(app.count("id:library-artifact-art-login")).toBe(0);
  expect(app.count("id:library-artifact-open-app-art-launch-board")).toBe(1);
  expect(app.count("id:library-artifact-manage-app-art-launch-board")).toBe(1);

  await app.press("id:library-artifact-open-app-art-launch-board");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "host.appletOpen"));
  expect(fake.calls.findLast((c) => c.op === "host.appletOpen")?.payload).toEqual({ artifactId: "art-launch-board" });

  await app.press("id:content-nav-recent");
  await fake.pump(app);
});
