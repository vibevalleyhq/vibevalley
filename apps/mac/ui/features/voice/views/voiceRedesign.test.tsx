import "../../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";

import { fakeHost } from "../../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../../fixtures/scenarios";

async function mountVoiceSettings(options: { locale?: "en" | "zh"; colorScheme?: "light" | "dark"; motion?: "off" | "on" | "system" } = {}) {
  const locale = options.locale ?? "en";
  setLocale(locale);
  const fake = fakeHost(scenarios.typical, {
    route: "/settings/voice",
    locale,
    ...(options.motion ? { motion: options.motion } : {}),
  });
  let voiceState = {
    phase: "idle" as "idle" | "connecting" | "live" | "stopping",
    muted: false,
    micLevel: 0,
    problem: null as string | null,
    heard: "",
    said: "",
  };
  fake.respond("host.voiceStart", () => {
    voiceState = {
      phase: "live",
      muted: false,
      micLevel: 0.68,
      problem: null,
      heard: "How many issues?",
      said: "Two issues are in progress.",
    };
    return voiceState;
  });
  fake.respond("host.voiceState", () => voiceState);
  fake.respond("host.voiceMute", (p: { muted: boolean }) => {
    voiceState = { ...voiceState, muted: p.muted, micLevel: p.muted ? 0 : 0.68 };
    return voiceState;
  });
  fake.respond("host.voiceStop", () => {
    voiceState = { phase: "idle", muted: false, micLevel: 0, problem: null, heard: "", said: "" };
    return voiceState;
  });

  const app = await open("../../../app/main.tsx", {
    width: 1200,
    height: 820,
    colorScheme: options.colorScheme ?? "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:voice-config") === 1);
  return { app, fake };
}

test("Voice & Call renders Orb, Waveform, MOSS Live stage, and inline model/key configuration in Light and Dark themes", async () => {
  for (const colorScheme of ["light", "dark"] as const) {
    const { app, fake } = await mountVoiceSettings({ colorScheme, locale: "en" });
    expect(app.count("id:voice-orb")).toBe(1);
    expect(app.count("id:native-call-waveform")).toBe(1);
    expect(app.count("id:voice-key-row")).toBe(1);
    expect(app.count("id:voice-live-model")).toBe(1);
    expect(app.count("id:voice-speech-model")).toBe(1);
    expect(app.count("id:voice-transcription-model")).toBe(1);

    await app.press("id:native-call-start");
    await fake.pumpUntil(app, () => app.count("id:native-call-heard") === 1);
    expect(app.texts()).toContain("How many issues?");
    expect(app.texts()).toContain("Two issues are in progress.");

    await app.press("id:native-call-mute");
    await fake.pump(app);
    expect(fake.calls.some((c) => c.op === "host.voiceMute")).toBe(true);

    await app.press("id:native-call-stop");
    await fake.pump(app);
    expect(fake.calls.some((c) => c.op === "host.voiceStop")).toBe(true);
  }
});

test("Voice & Call respects reduceMotion off and saves updated MOSS key and model bindings", async () => {
  const { app, fake } = await mountVoiceSettings({ locale: "en", motion: "off" });
  expect(app.count("id:voice-orb")).toBe(1);
  expect(app.count("id:native-call-waveform")).toBe(1);

  await app.type("id:voice-key-row >> id:secret", "moss-secret-9999");
  await fake.pump(app);
  expect(app.count("id:save-bar-dirty")).toBe(1);
  await app.press("id:save");
  await fake.pump(app);

  const updateCall = fake.calls.findLast((c) => c.op === "provider.update");
  expect(updateCall).toBeDefined();
  const payload = updateCall!.payload as { connections: { key?: string }[] };
  expect(payload.connections[0]?.key).toBe("moss-secret-9999");
});
