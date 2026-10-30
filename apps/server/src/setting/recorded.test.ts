import type { SettingsUpdate, SettingsUpdateVoice, VoiceSettings } from "@vibevalley/protocol";
import { defaultVoice, voiceOverrides, voiceProblem, voiceSettingsOver } from "./voice.ts";
import { keyHint } from "./keys.ts";
import { memorySourcesProblem } from "./memorySources.ts";
import { settingsProblem } from "./saving.ts";
import { expect, test } from "vite-plus/test";
import { checkCases, goldenCases } from "@/testing/golden.ts";
test("the recorded cases", () => {
  const cases = goldenCases("setting");
  expect(new Set(cases.map((c) => c.fn)).size).toBe(4);
  const failed = checkCases(cases, (c) => {
    switch (c.fn) {
      case "settingsProblem":
        return settingsProblem(c.in as SettingsUpdate) || null;
      case "voiceProblem":
        return voiceProblem(c.in as SettingsUpdateVoice) || null;
      case "voiceOverrides": {
        const want = c.out as { overrides: SettingsUpdateVoice };
        return { overrides: voiceOverrides(defaultVoice(), c.in as VoiceSettings), settings: voiceSettingsOver(defaultVoice(), want.overrides) };
      }
      case "keyHint":
        return keyHint(c.in as string);
      default:
        throw new Error(`line ${c.line}: no rule ${c.fn}`);
    }
  });
  expect(failed).toEqual([]);
});

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
