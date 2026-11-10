import { expect, test } from "vite-plus/test";

import { keyHint, memorySourcesProblem, settingsProblem } from "./memorySources.ts";
import { defaultVoice, voiceOverrides, voiceSettingsOver } from "./voice.ts";

test("what settings refuse", () => {
  expect(settingsProblem({ deepseekApiKey: "sk has spaces" })).toMatch(/DeepSeek/u);
  expect(settingsProblem({ agoraAppCertificate: "123" })).toMatch(/Certificate/u);
  // An own address is checked; while MOSS is chosen the address kept beside it is not.
  expect(settingsProblem({ dictation: { via: "own", url: "not a url", model: "m" } })).not.toBe("");
  expect(settingsProblem({ dictation: { via: "own", url: "http://127.0.0.1:8080/v1", model: "" } })).not.toBe("");
  expect(settingsProblem({ dictation: { via: "moss", url: "not a url", model: "" } })).toBe("");
  expect(settingsProblem({ agoraAppId: "not-an-app-id" })).toMatch(/App ID/u);
  expect(settingsProblem({ deepseekApiKey: "", agoraAppId: "" })).toBe("");
  expect(settingsProblem({ agoraAppId: "0123456789ABCDEF0123456789abcdef", deepseekApiKey: " sk-12345678 " })).toBe("");
  expect(settingsProblem({ ttsKey: " a b " })).toMatch(/空格/u);
  expect(settingsProblem({ voice: { silenceMs: 50 } })).toMatch(/200 到 2000/u);
  expect(settingsProblem({ voice: { persona: "  " } })).toMatch(/人设/u);
  expect(settingsProblem({ voice: { answer: { vendor: "openai", url: "not a url", model: "x" } } })).toMatch(/http/u);
  expect(keyHint("sk-saved-in-settings-1234")).toBe("…1234");
  expect(keyHint("ab")).toBe("…ab");
});

test("the voice keeps only what differs", () => {
  const defaults = defaultVoice();
  const wanted = { ...defaults, area: "CN" as const, silenceMs: 600, greeting: "在呢。" };
  const over = voiceOverrides(defaults, wanted);
  expect(over).toEqual({ area: "CN", silenceMs: 600, greeting: "在呢。" });
  expect(voiceSettingsOver(defaults, over)).toEqual(wanted);
  expect(voiceSettingsOver(defaults, {})).toEqual(defaults);
  const tts = { vendor: "microsoft", region: "eastasia", voiceName: "zh-CN-XiaoxiaoNeural" } as const;
  expect(voiceOverrides(defaults, { ...defaults, tts })).toEqual({ tts });
});

test("memory sources", () => {
  const on = { kind: "nowledge", url: "http://127.0.0.1:14242/mcp/", enabled: true, read: false, write: false } as const;
  expect(memorySourcesProblem([on])).toBe("");
  expect(memorySourcesProblem([on, on])).toMatch(/只能接一个/u);
  expect(memorySourcesProblem([{ ...on, kind: "mem0" as never }])).toMatch(/不认识/u);
  expect(memorySourcesProblem([{ ...on, url: "" }])).toMatch(/先填它的地址/u);
  expect(memorySourcesProblem([{ ...on, url: "127.0.0.1:14242" }])).toMatch(/http/u);
  expect(settingsProblem({ memorySources: [{ ...on, enabled: false, url: "", key: "a b" }] })).toMatch(/空格/u);
});
