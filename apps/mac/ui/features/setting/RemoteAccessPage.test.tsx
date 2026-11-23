import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { RemoteDeviceSummary, RemotePairCode, RemoteStatus } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import { fakeHost, type FakeHost } from "../../app/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";
import { shortMomentText } from "../../infra/base/format";

const sampleDevices: readonly RemoteDeviceSummary[] = [
  {
    id: "dev-ios",
    name: "Lucas iPhone",
    platform: "ios",
    scope: "remote",
    createdAt: SCENARIO_NOW - 3_600_000,
    lastSeenAt: SCENARIO_NOW - 120_000,
  },
  {
    id: "dev-android",
    name: "Pixel Fold",
    platform: "android",
    scope: "remote",
    createdAt: SCENARIO_NOW - 7_200_000,
  },
  {
    id: "dev-cli",
    name: "MacBook CLI",
    platform: "cli",
    scope: "remote:default",
    createdAt: SCENARIO_NOW - 7_800_000,
  },
  {
    id: "dev-machine",
    name: "GPU Node",
    platform: "machine",
    scope: "remote:runtime",
    createdAt: SCENARIO_NOW - 8_200_000,
  },
  {
    id: "dev-sandbox",
    name: "CI Container",
    platform: "sandbox",
    scope: "remote:runtime",
    createdAt: SCENARIO_NOW - 8_600_000,
  },
  {
    id: "dev-other",
    name: "iPad Browser",
    platform: "other",
    scope: "remote",
    createdAt: SCENARIO_NOW - 9_000_000,
    lastSeenAt: SCENARIO_NOW - 600_000,
  },
];

const samplePairCode: RemotePairCode = {
  code: "482-915",
  pairUrl: "vibevalley://pair?url=http%3A%2F%2F100.64.1.23%3A8791&code=482-915",
  url: "http://100.64.1.23:8791",
  expiresAt: SCENARIO_NOW + 300_000,
};

async function mountSettings(route: string, configure?: (fake: FakeHost) => void) {
  const fake = fakeHost(scenarios.typical, { route, locale: "en" });
  fake.respond("host.qr", { size: 5, rows: ["11111", "10001", "10101", "10001", "11111"] });
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

test("RemoteAccessPage: disabled -> enable -> pair/QR/copy -> revoke device -> disable", async () => {
  setLocale("en");
  let devices: RemoteDeviceSummary[] = [];
  let state: RemoteStatus = {
    enabled: false,
    listening: false,
    port: 8791,
    tailscaleOnline: false,
    devices,
  };

  const { app, fake } = await mountSettings("/settings/connections/remote", (f) => {
    f.respond("remote.status", () => ({ ...state, devices: [...devices] }));
    f.respond("remote.enable", () => {
      devices = sampleDevices.map((d) => ({ ...d }));
      state = {
        enabled: true,
        listening: true,
        bindAddr: "100.64.1.23",
        port: 8791,
        tailscaleIp: "100.64.1.23",
        tailscaleHost: "studio-mac.tailnet.ts.net",
        tailscaleOnline: true,
        url: "http://100.64.1.23:8791",
        devices,
      };
      return { ...state, devices: [...devices] };
    });
    f.respond("remote.disable", () => {
      state = {
        ...state,
        enabled: false,
        listening: false,
        url: undefined,
      };
      return { ...state, devices: [...devices] };
    });
    f.respond("remote.pair.create", () => samplePairCode);
    f.respond("remote.device.revoke", (payload: unknown) => {
      const id = (payload as { id: string }).id;
      devices = devices.filter((d) => d.id !== id);
      return null;
    });
  });
  const clock = app.clock;
  if (!clock) throw new Error("virtual clock required");

  await fake.pumpUntil(app, () => app.count("id:remote-access-page") === 1);
  expect(app.count("id:connections-subnav-chat")).toBe(1);
  expect(app.count("id:connections-subnav-github")).toBe(1);
  expect(app.count("id:connections-subnav-remote")).toBe(1);
  expect(app.texts()).toContain(t("web.remote.title"));
  expect(app.texts()).toContain(t("web.remote.toggle.disabled"));
  expect(app.texts()).toContain(t("web.remote.tailscale.offline"));
  expect(app.count("id:remote-pair-create")).toBe(0);
  expect(app.count("id:remote-url-row")).toBe(0);
  expect(app.count("id:remote-devices-empty")).toBe(1);
  expect(app.texts()).toContain(t("web.remote.devices.empty"));

  await app.press("id:remote-enable");
  await fake.pumpUntil(app, () => app.count("id:remote-pair-create") === 1);
  expect(fake.calls.find((c) => c.op === "remote.enable")?.payload).toEqual({});
  expect(app.texts()).toContain(t("web.remote.toggle.enabled"));
  expect(app.texts()).toContain(t("web.remote.tailscale.online"));
  expect(app.texts()).toContain("100.64.1.23");
  expect(app.texts()).toContain("studio-mac.tailnet.ts.net");
  expect(app.texts()).toContain("http://100.64.1.23:8791");
  expect(app.count("id:remote-url-row")).toBe(1);
  expect(app.count("id:remote-devices-empty")).toBe(0);
  expect(app.count("id:remote-device-dev-ios")).toBe(1);
  expect(app.count("id:remote-device-dev-android")).toBe(1);
  expect(app.count("id:remote-device-dev-cli")).toBe(1);
  expect(app.count("id:remote-device-dev-machine")).toBe(1);
  expect(app.count("id:remote-device-dev-sandbox")).toBe(1);
  expect(app.count("id:remote-device-dev-other")).toBe(1);
  expect(app.texts()).toContain("Lucas iPhone");
  expect(app.texts()).toContain(t("web.remote.devices.platform.ios"));
  expect(app.texts()).toContain(t("web.remote.devices.platform.android"));
  expect(app.texts()).toContain(t("web.remote.devices.platform.cli"));
  expect(app.texts()).toContain(t("web.remote.devices.platform.machine"));
  expect(app.texts()).toContain(t("web.remote.devices.platform.sandbox"));
  expect(app.texts()).toContain(t("web.remote.devices.platform.other"));
  expect(app.texts()).toContain(t("web.remote.devices.lastSeen", { time: shortMomentText(SCENARIO_NOW - 120_000, SCENARIO_NOW) }));

  await app.press("id:remote-pair-create");
  await fake.pumpUntil(app, () => app.count("id:remote-pair-panel") === 1 && fake.calls.some((c) => c.op === "host.qr"));
  expect(fake.calls.some((c) => c.op === "remote.pair.create")).toBe(true);
  expect(fake.calls.find((c) => c.op === "host.qr")?.payload).toEqual({ text: samplePairCode.pairUrl, border: 2 });
  expect(app.count("id:remote-pair-qr")).toBe(1);
  expect(app.texts()).toContain(samplePairCode.code);
  expect(app.texts()).toContain(t("web.remote.pair.qrHint"));
  expect(app.texts()).toContain(t("web.remote.pair.code"));
  expect(app.texts()).toContain(t("web.remote.pair.copy"));
  expect(app.texts()).toContain(t("web.remote.pair.expires", { time: shortMomentText(samplePairCode.expiresAt, SCENARIO_NOW) }));

  await app.press("id:remote-pair-copy");
  await fake.pumpUntil(app, () => app.texts().includes(t("web.remote.pair.copied")));
  expect(app.clipboard()).toBe(samplePairCode.pairUrl);
  await clock.fastForward(2_100);
  await fake.pumpUntil(app, () => app.texts().includes(t("web.remote.pair.copy")));

  const statusCallsBeforeRevoke = fake.calls.filter((c) => c.op === "remote.status").length;
  await app.press("id:remote-device-revoke-dev-ios");
  await fake.pumpUntil(app, () => app.count("id:remote-device-dev-ios") === 0);
  expect(fake.calls.find((c) => c.op === "remote.device.revoke")?.payload).toEqual({ id: "dev-ios" });
  expect(fake.calls.filter((c) => c.op === "remote.status").length).toBeGreaterThan(statusCallsBeforeRevoke);
  expect(app.count("id:remote-device-dev-android")).toBe(1);

  await app.press("id:remote-disable");
  await fake.pumpUntil(app, () => app.count("id:remote-enable") === 1);
  expect(fake.calls.some((c) => c.op === "remote.disable")).toBe(true);
  expect(app.texts()).toContain(t("web.remote.toggle.disabled"));
  expect(app.count("id:remote-pair-create")).toBe(0);
  expect(app.count("id:remote-pair-panel")).toBe(0);
  expect(app.count("id:remote-url-row")).toBe(0);
});

test("SettingsPage: legacy /settings/remote redirect, search words, sub-tab navigation, and action error banner", async () => {
  setLocale("en");
  const { app, fake } = await mountSettings("/settings/remote", (f) => {
    f.respond("remote.status", () => ({
      enabled: false,
      listening: false,
      port: 8791,
      tailscaleOnline: false,
      devices: [],
    }));
    f.respond("remote.enable", () => ({ bizCode: BizCode.InternalError, message: "Tailscale listener bind failed" }));
  });

  await fake.pumpUntil(app, () => app.count("id:remote-access-page") === 1);
  expect(app.count("id:connections-subnav")).toBe(1);

  await app.press("id:remote-enable");
  await fake.pumpUntil(app, () => app.count("id:remote-error") === 1);
  expect(app.texts()).toContain("Tailscale listener bind failed");

  await app.type("id:settings-search", "tailscale");
  expect(app.count("id:settings-section-connections")).toBe(1);
  expect(app.count("id:settings-section-general")).toBe(0);

  await app.press("id:connections-subnav-github");
  await fake.pumpUntil(app, () => app.count("id:remote-access-page") === 0);
  await app.press("id:connections-subnav-remote");
  await fake.pumpUntil(app, () => app.count("id:remote-access-page") === 1);
});
