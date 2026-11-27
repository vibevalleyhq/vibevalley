import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { UpdateFailureKind, UpdateState } from "@vibevalley/protocol/host";

import { fakeHost, type FakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";
import { ago } from "../../infra/base/format";

async function mountAbout(initialState: UpdateState, configure?: (fake: FakeHost) => void) {
  setLocale("en");
  const fake = fakeHost(scenarios.typical, { route: "/settings/about", locale: "en" });
  fake.respond("host.updateState", initialState);
  fake.respond("host.updateCheck", null);
  fake.respond("host.updateInstall", null);
  configure?.(fake);
  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:update-state") === 1);
  return { app, fake };
}

test("UpdateRow: disabled state hides check button and never fakes up-to-date", async () => {
  const { app } = await mountAbout({ _tag: "disabled", version: "0.4.0-dev" });
  expect(app.texts()).toContain(t("web.setting.about.disabled"));
  expect(app.count("id:update-check")).toBe(0);
  expect(app.count("id:update-retry")).toBe(0);
  expect(app.count("id:update-install")).toBe(0);
});

test("UpdateRow: idle with checkedAt transitions cleanly through instant push events (checking -> downloading -> verifying -> ready -> installing)", async () => {
  const checkedAt = SCENARIO_NOW - 180_000;
  let current: UpdateState = { _tag: "idle", version: "0.4.0", checkedAt };

  const { app, fake } = await mountAbout(current, (f) => {
    f.respond("host.updateState", () => current);
    f.respond("host.updateCheck", () => {
      current = { _tag: "checking", version: "0.4.0" };
      return null;
    });
  });

  expect(app.texts()).toContain(t("web.setting.about.upToDate"));
  expect(app.count("id:update-last-checked")).toBe(1);
  expect(app.texts()).toContain(t("web.setting.about.lastChecked", { time: ago(checkedAt, SCENARIO_NOW) }));
  expect(app.count("id:update-check")).toBe(1);

  // Trigger non-blocking check -> transitions to checking with animated busy indicator without showing an "Up to date" toast.
  await app.press("id:update-check");
  await fake.pumpUntil(app, () => app.texts().includes(t("web.setting.about.checking")));
  expect(app.count("id:update-check")).toBe(0);
  expect(app.count("id:update-busy-indicator")).toBe(1);

  // Instant host push: downloading renders the embedded active card with inline progress & transfer details, plus modal Details.
  await fake.pushUpdateState(app, {
    _tag: "downloading",
    version: "0.4.0",
    next: "0.5.0",
    percent: 49,
    downloadedBytes: Math.round(42.1 * 1024 * 1024),
    totalBytes: Math.round(86.4 * 1024 * 1024),
    speedBps: Math.round(3.2 * 1024 * 1024),
  });
  await fake.pumpUntil(app, () => app.count("id:update-active-card") === 1 && app.count("id:update-details") === 1);
  expect(app.count("id:update-inline-progress")).toBe(1);
  expect(app.count("id:update-inline-transfer")).toBe(1);
  expect(app.texts()).toContain(t("web.setting.about.downloading", { next: "0.5.0", percent: 49 }));
  expect(app.texts()).toContain("42.1 / 86.4 MB · 3.2 MB/s");
  await app.press("id:update-details");
  await fake.pumpUntil(app, () => app.count("id:update-dialog") === 1 && app.count("id:update-progress") === 1);
  expect(app.count("id:update-transfer")).toBe(1);

  // Instant host push: verifying returns to single-row busy indicator (prevents 100% freeze perception).
  await fake.pushUpdateState(app, {
    _tag: "verifying",
    version: "0.4.0",
    next: "0.5.0",
  });
  await fake.pumpUntil(app, () => app.texts().includes(t("web.setting.about.verifying", { next: "0.5.0" })));
  expect(app.count("id:update-inline-progress")).toBe(0);
  expect(app.count("id:update-busy-indicator")).toBe(1);

  // Instant host push: ready renders embedded update card with inline notes preview and opens UpdateDialog on Restart.
  await fake.pushUpdateState(app, {
    _tag: "ready",
    version: "0.4.0",
    next: "0.5.0",
    notes: ["Instant push updates", "Resumable HTTP Range downloads"],
    newFarm: false,
    page: "https://github.com/vibevalleyhq/vibevalley/releases/tag/v0.5.0",
  });
  await fake.pumpUntil(app, () => app.count("id:update-active-card") === 1 && app.count("id:update-install") === 1);
  expect(app.count("id:update-inline-notes")).toBe(1);
  expect(app.texts()).toContain(t("web.setting.about.ready", { next: "0.5.0" }));
  expect(app.texts()).toContain(t("web.setting.about.releaseNotesLink"));
  expect(app.texts()).toContain("Instant push updates");
  expect(app.texts()).toContain("Resumable HTTP Range downloads");

  // Pressing update-install opens the shared UpdateDialog modal with release notes & confirm button (no inline horizontal squeeze).
  fake.clearCalls();
  await app.press("id:update-install");
  await fake.pumpUntil(app, () => app.count("id:update-dialog") === 1 && app.count("id:update-install-sure") === 1);
  expect(app.count("id:update-notes")).toBe(1);
  await app.press("id:update-install-sure");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "host.updateInstall"));

  await fake.pushUpdateState(app, {
    _tag: "installing",
    version: "0.4.0",
    next: "0.5.0",
  });
  await fake.pumpUntil(app, () => app.count("id:update-installing-btn") === 1);
  expect(app.count("id:update-busy-indicator")).toBe(1);
  expect(app.texts()).toContain(t("web.setting.about.installing", { next: "0.5.0" }));
});

test("UpdateRow: manual state shows localized instructions and download link", async () => {
  const { app } = await mountAbout({
    _tag: "manual",
    version: "0.4.0",
    next: "0.5.0",
    why: "translocated",
    page: "https://github.com/vibevalleyhq/vibevalley/releases/tag/v0.5.0",
  });
  expect(app.texts()).toContain(t("web.setting.about.manual.translocated", { next: "0.5.0" }));
  expect(app.texts()).toContain(t("web.setting.about.download"));
  expect(app.count("id:update-check")).toBe(0);
});

test("UpdateRow: failed state maps every UpdateFailureKind, displays raw detail, allows retry and manual download fallback", async () => {
  const kinds: readonly UpdateFailureKind[] = ["network", "rateLimit", "integrity", "signature", "permission", "install", "unknown"];
  const { app, fake } = await mountAbout({
    _tag: "failed",
    version: "0.4.0",
    why: "HTTP 403 API rate limit exceeded",
    kind: "rateLimit",
    page: "https://github.com/vibevalleyhq/vibevalley/releases/latest",
  });

  expect(app.texts()).toContain(t("web.setting.about.failedKind.rateLimit"));
  expect(app.count("id:update-failed-detail")).toBe(0);
  expect(app.count("id:update-details")).toBe(1);
  await app.press("id:update-details");
  await fake.pumpUntil(app, () => app.count("id:update-dialog") === 1 && app.count("id:update-failed-detail") === 1);
  expect(app.texts()).toContain("HTTP 403 API rate limit exceeded");
  expect(app.count("id:update-retry")).toBe(1);
  expect(app.texts()).toContain(t("web.setting.about.manualDownload"));

  for (const kind of kinds) {
    await fake.pushUpdateState(app, {
      _tag: "failed",
      version: "0.4.0",
      why: `raw-${kind}`,
      kind,
      page: "https://github.com/vibevalleyhq/vibevalley/releases/latest",
    });
    await fake.pumpUntil(app, () => app.texts().includes(t(`web.setting.about.failedKind.${kind}`)));
    expect(app.texts()).toContain(`raw-${kind}`);
  }

  // Pressing retry triggers host.updateCheck.
  fake.clearCalls();
  await app.press("id:update-retry");
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "host.updateCheck"));
});

test("UpdateRow: check settles back to idle toasts up-to-date only after check finishes", async () => {
  let current: UpdateState = { _tag: "idle", version: "0.4.0" };
  const { app, fake } = await mountAbout(current, (f) => {
    f.respond("host.updateState", () => current);
    f.respond("host.updateCheck", () => {
      current = { _tag: "checking", version: "0.4.0" };
      return null;
    });
  });

  await app.press("id:update-check");
  await fake.pumpUntil(app, () => app.texts().includes(t("web.setting.about.checking")));
  // Not idle yet -> no "Up to date" text visible while checking.
  expect(app.texts()).not.toContain(t("web.setting.about.upToDate"));

  // Host pushes idle once background check finishes -> state returns to idle and toast appears.
  current = { _tag: "idle", version: "0.4.0", checkedAt: SCENARIO_NOW };
  await fake.pushUpdateState(app, current);
  await fake.pumpUntil(app, () => app.count("id:update-last-checked") === 1);
  expect(app.texts().filter((txt) => txt === t("web.setting.about.upToDate")).length).toBeGreaterThanOrEqual(2);
});
