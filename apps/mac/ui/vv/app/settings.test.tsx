// The settings sections ported after round 3, on the bridge with fakeHost
// playing the Rust side (fixtures/settings.ts): model providers, MOSS
// accounts, the call, MOSS Live and dictation forms, the chat apps.
import "../polyfill";
import { expect, open, test } from "nsh/test";

import { responses, state } from "../fixtures/workbench";
import { fakeHost } from "./fakeHost";

async function start(route: string, width = 1200) {
  const fake = fakeHost({ state, responses }, { route });
  const app = await open("./main.tsx", { width, height: 800, colorScheme: "light", platform: "macos", host: fake.options });
  await fake.pump(app);
  await fake.pump(app);
  return { app, fake };
}

test("providers: each use bound to an account and a model, and saved whole", async () => {
  const { app, fake } = await start("/settings/providers");
  expect(app.count("id:provider-form")).toBe(1);
  for (const use of ["image", "understanding", "dictation", "speech", "speakers", "voiceDesign", "transcription", "live", "vision"])
    expect(app.count(`id:provider-use-${use}`)).toBe(1);
  // Bound uses show their model pick; unbound ones only the account.
  expect(app.count("id:provider-image-model")).toBe(1);
  expect(app.count("id:provider-speech-model")).toBe(0);
  expect(app.count("id:save-bar")).toBe(1);
  expect(fake.calls.map((c) => c.op)).toContain("provider.get");
});

test("accounts: the MOSS connection, its key, its models on request, and Agora's credentials", async () => {
  const { app, fake } = await start("/settings/accounts");
  expect(app.count("id:deepseek-form")).toBe(1);
  expect(app.count("id:provider-connection")).toBe(1);
  expect(app.value("id:provider-name")).toBe("MOSS");
  expect(app.count("id:key-mark-settings")).toBeGreaterThan(0);
  expect(app.count("id:agora-app-id")).toBe(1);
  await app.press("id:provider-models");
  await fake.pump(app);
  expect(app.count("id:provider-model-list")).toBe(1);
  expect(app.texts()).toContain("moss-live");
  await app.press("id:provider-adapted-toggle");
  expect(app.texts().some((s) => s.includes("moss-image-1-hd"))).toBe(true);
  await app.type("id:provider-name", " 2");
  await fake.pump(app);
  expect(app.count("id:save-bar-dirty")).toBeGreaterThan(0);
  await app.press("id:provider-add");
  expect(app.count("id:provider-connection")).toBe(2);
});

test("call: the line, listening and who answers; a changed vendor can be saved or reset", async () => {
  const { app, fake } = await start("/settings/call");
  expect(app.count("id:voice-call")).toBe(1);
  for (const id of ["voice-area", "voice-asr", "voice-language", "voice-silenceMs", "voice-interruptMs", "voice-idleSeconds", "voice-answer"])
    expect(app.count(`id:${id}`)).toBe(1);
  expect(app.enabled("id:reset")).toBe(false);
  await app.press("id:voice-answer >> text:DeepSeek");
  await fake.pump(app);
  expect(app.count("id:save-bar-dirty")).toBe(1);
  expect(app.enabled("id:reset")).toBe(true);
  await app.press("id:save");
  await fake.pump(app);
  expect(fake.calls.some((c) => c.op === "setting.update")).toBe(true);
});

test("MOSS Live checks the account; dictation through one's own server asks for its address", async () => {
  const { app, fake } = await start("/settings/moss");
  expect(app.count("id:voice-moss")).toBe(1);
  await app.press("id:moss-verify");
  await fake.pump(app);
  expect(fake.calls.map((c) => c.op)).toContain("voice.moss.verify");
  expect(app.count("id:moss-ok")).toBe(1);
  await app.press("id:settings-section-dictation");
  await fake.pump(app);
  expect(app.count("id:dictation-provider-link")).toBe(1);
  expect(app.count("id:dictation-url")).toBe(0);
  await app.press("id:dictation-via >> text:" + "自己的地址");
  await fake.pump(app);
  expect(app.count("id:dictation-url")).toBe(1);
  expect(app.count("id:dictation-model")).toBe(1);
});

test("chat apps: WeChat connected to a channel, Feishu waiting on its code, QQ asks for its bot", async () => {
  const { app, fake } = await start("/settings/chat");
  expect(app.count("id:connectors")).toBe(1);
  expect(app.count("id:connector-weixin")).toBe(1);
  expect(app.count("id:connector-channel")).toBe(1);
  expect(app.count("id:connector-logout")).toBe(1);
  await app.press("id:list-row-feishu");
  await fake.pump(app);
  expect(app.count("id:connector-feishu")).toBe(1);
  expect(app.count("id:connector-refresh")).toBe(1);
  await app.press("id:list-row-qq");
  await fake.pump(app);
  expect(app.enabled("id:connector-login")).toBe(false);
  await app.type("id:qq-app-id", "102000001");
  await app.type("id:qq-secret", "secret");
  expect(app.enabled("id:connector-login")).toBe(true);
  await app.press("id:connector-login");
  await fake.pump(app);
  expect(fake.calls.find((c) => c.op === "connector.login")?.payload).toEqual({ id: "qq", appId: "102000001", secret: "secret" });
});

test("narrow: the settings list over the section", async () => {
  const { app } = await start("/settings/chat", 560);
  expect(app.count("id:settings-nav")).toBe(1);
  expect(app.count("id:connectors")).toBe(1);
});
