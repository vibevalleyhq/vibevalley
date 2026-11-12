import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { Secret } from "@vibevalley/protocol/schema";

import type { ServerConfig } from "#/infra/config.ts";
import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { testConfig } from "#/testing/layers.ts";

import { makeSetting, type Setting } from "./setting.ts";
import { defaultVoice } from "./voice.ts";
const appId = "11111111111111111111111111111111";
const cert = "22222222222222222222222222222222";

/** A key as a call would send it; undefined when there is none. */
const reveal = (key: Secret | undefined) => (key === undefined ? undefined : key.reveal());

/** The settings over config, closed once body is done: a second run reads what the first saved. */
const run = async (config: ServerConfig, body: (s: Setting) => Promise<void>) => {
  const s = await makeSetting({ config, clock: wallTime, log: keptLog() });
  try {
    await body(s);
  } finally {
    await s.close();
  }
};
const failure = (p: Promise<unknown>) =>
  p.then(
    () => expect.unreachable("it was saved"),
    (e: unknown) => (e instanceof Error ? e : expect.unreachable(String(e))),
  );
const file = (config: ServerConfig) => JSON.parse(readFileSync(join(config.home, "settings.json"), "utf8")) as Record<string, unknown>;

describe("settings", () => {
  test("a key saved here wins over the configuration's, and only its end is ever shown", async () => {
    const config = testConfig({ deepseek: { apiKey: new Secret("sk-from-the-env-0000") } });
    await run(config, async (s) => {
      expect(s.status().deepseekApiKey).toEqual({ source: "config", hint: "…0000" });
      expect(s.status().agoraAppId).toEqual({ source: null });
      const after = await s.save({ deepseekApiKey: " sk-saved-in-settings-1234 ", agoraAppId: appId, agoraAppCertificate: cert });
      expect(after.deepseekApiKey).toEqual({ source: "settings", hint: "…1234" });
      expect(after.agoraAppId).toEqual({ source: "settings", value: appId });
      expect(after.agoraAppCertificate).toEqual({ source: "settings", hint: "…2222" });
      expect(JSON.stringify(after)).not.toContain("sk-saved");
      expect(reveal(s.deepseekApiKey())).toBe("sk-saved-in-settings-1234");
      const agora = s.agora();
      expect(agora?.appId).toBe(appId);
      expect(reveal(agora?.appCertificate)).toBe(cert);
      expect(statSync(join(config.home, "settings.json")).mode & 0o777).toBe(0o600);
      expect(file(config)).toEqual({ deepseekApiKey: "sk-saved-in-settings-1234", agoraAppId: appId, agoraAppCertificate: cert });
      const cleared = await s.save({ deepseekApiKey: "" });
      expect(cleared.deepseekApiKey).toEqual({ source: "config", hint: "…0000" });
      expect(cleared.agoraAppId.value).toBe(appId);
      expect(file(config)).not.toHaveProperty("deepseekApiKey");
    });
    await run(config, async (again) => {
      expect(again.agora()?.appId).toBe(appId);
    });
  });

  test("names the space's repositories, worktrees and notes", async () => {
    const config = testConfig();
    await run(config, async (s) => {
      expect(s.status().paths).toEqual({
        repos: join(config.workRoot, "repos"),
        worktrees: join(config.workRoot, "worktrees"),
        pkm: join(config.workRoot, "pkm"),
      });
    });
  });

  test("nothing is saved when something cannot be right", async () => {
    await run(testConfig(), async (s) => {
      const refused = await failure(s.save({ agoraAppId: "not-an-app-id" }));
      expect(refused.message).toMatch(/App ID/u);
      expect(s.agora()).toBeUndefined();
    });
  });

  test("the voice keeps only what differs from its defaults, which the configuration sets", async () => {
    const config = testConfig({ voice: { id: "English_captivating_female1", line: { port: 0, url: "" } } });
    await run(config, async (s) => {
      const before = s.status();
      expect(before.voiceDefaults.answer).toEqual({ vendor: "orchestrator" });
      expect(before.voiceDefaults.tts).toEqual({ vendor: "minimax", model: "speech_2_6_turbo", voiceId: "English_captivating_female1" });
      expect(before.voiceDefaults.greeting).toBe(defaultVoice().greeting);
      expect(before.voice).toEqual(before.voiceDefaults);
      const wanted = { ...before.voiceDefaults, area: "CN" as const, silenceMs: 600, greeting: "在呢。" };
      expect((await s.save({ voice: { area: "CN", silenceMs: 600, greeting: "在呢。" } })).voice).toEqual(wanted);
      expect(s.voice()).toEqual(wanted);
      expect(file(config).voice).toEqual({ area: "CN", silenceMs: 600, greeting: "在呢。" });
      // The page sends the voice whole: what equals the defaults is left out all the same.
      await s.save({ voice: wanted });
      expect(file(config).voice).toEqual({ area: "CN", silenceMs: 600, greeting: "在呢。" });
      expect(s.validate({ voice: { persona: "  " } }).problem).toBeTruthy();
      await s.save({ agoraAppId: appId });
      expect(s.voice().area).toBe("CN");
      const reset = await s.save({ voice: {} });
      expect(reset.voice).toEqual(reset.voiceDefaults);
      expect(file(config)).not.toHaveProperty("voice");
      expect((await failure(s.save({ voice: { silenceMs: 50 } }))).message).toMatch(/200 到 2000/u);
    });
  });

  test("a voice vendor's key is a hint", async () => {
    const config = testConfig();
    await run(config, async (s) => {
      expect(s.status().ttsKey).toEqual({ source: null });
      const tts = { vendor: "microsoft", region: "eastasia", voiceName: "zh-CN-XiaoxiaoNeural" } as const;
      const after = await s.save({ voice: { tts }, ttsKey: " azure-speech-key-9f3a " });
      expect(after.voice.tts).toEqual(tts);
      expect(after.ttsKey).toEqual({ source: "settings", hint: "…9f3a" });
      expect(JSON.stringify(after)).not.toContain("azure-speech-key");
      const { asrKey, llmKey, ttsKey } = s.voiceConfig().keys;
      expect([asrKey, llmKey, ttsKey].map(reveal)).toEqual(["", "", "azure-speech-key-9f3a"]);
      expect(file(config).voice).toEqual({ tts });
    });
  });

  test("provider credentials persist once and settings expose only readiness", async () => {
    const config = testConfig();
    await run(config, async (setting) => {
      expect(setting.status().readiness.live).toEqual({ ready: false, missing: "mossAccount" });
      await setting.updateProviders(() => ({
        revision: 1,
        connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: new Secret("test-private-key") }],
        dictation: { connection: "moss", model: "moss-transcribe-1.0" },
        image: { connection: "moss", model: "moss-image-sft-1.0-2026-10-09" },
        understanding: { connection: "moss", model: "moss-vl-1.0-2026-07-08" },
        speech: { connection: "moss", model: "moss-tts-1.0-pro-2026-02-07" },
        live: { connection: "moss", model: "moss-live-1.0" },
        speakers: { connection: "moss", model: "moss-ttsd-1.0" },
        voiceDesign: { connection: "moss", model: "moss-voice-generator-1.0" },
        transcription: { connection: "moss", model: "moss-transcribe-diarize-pro" },
        vision: { connection: "moss", model: "moss-vl-realtime-1.0" },
      }));
      expect(setting.status()).toMatchObject({ readiness: { live: { ready: true }, dictation: { ready: true } } });
      expect(JSON.stringify(setting.status())).not.toContain("test-private-key");
      expect(file(config)).not.toHaveProperty("mossKey");
      expect(statSync(join(config.home, "settings.json")).mode & 0o777).toBe(0o600);
    });
    await run(config, async (setting) => {
      const key = setting.providers().connections[0]?.key;
      expect(key === undefined ? undefined : key.reveal()).toBe("test-private-key");
      expect(setting.providers().revision).toBe(1);
      expect(setting.providers().image).toEqual({ connection: "moss", model: "moss-image-sft-1.0-2026-10-09" });
      expect(setting.providers().understanding).toEqual({ connection: "moss", model: "moss-vl-1.0-2026-07-08" });
      expect(setting.providers().live).toEqual({ connection: "moss", model: "moss-live-1.0" });
      expect(setting.providers().speakers).toEqual({ connection: "moss", model: "moss-ttsd-1.0" });
      expect(setting.providers().voiceDesign).toEqual({ connection: "moss", model: "moss-voice-generator-1.0" });
      expect(setting.providers().transcription).toEqual({ connection: "moss", model: "moss-transcribe-diarize-pro" });
      expect(setting.providers().vision).toEqual({ connection: "moss", model: "moss-vl-realtime-1.0" });
    });
  });

  test("a memory source keeps its key until cleared", async () => {
    const config = testConfig();
    const nowledge = { kind: "nowledge", url: " http://127.0.0.1:14242/mcp/ ", enabled: true, read: true, write: true, key: "nmem-secret-9876" } as const;
    await run(config, async (s) => {
      expect(s.status().memorySources).toEqual([]);
      expect((await s.save({ memorySources: [nowledge] })).memorySources[0]!.key).toEqual({ source: "settings", hint: "…9876" });
      const { key: _key, ...keyless } = nowledge;
      await s.save({ memorySources: [{ ...keyless, write: false }] });
      expect(s.memorySources().map(({ key, ...source }) => ({ ...source, key: reveal(key) }))).toEqual([
        { kind: "nowledge", url: "http://127.0.0.1:14242/mcp/", enabled: true, read: true, key: "nmem-secret-9876" },
      ]);
      await s.save({ deepseekApiKey: "sk-other-key-0000" });
      expect(s.memorySources()).toHaveLength(1);
      await s.save({ memorySources: [] });
      expect(s.memorySources()).toEqual([]);
    });
  });

  test("an unreadable or invalid settings file is kept aside untouched, and the settings start empty", async () => {
    const cases = ["{not json", JSON.stringify({ deepseekApiKey: 7, agoraAppId: appId })];
    for (const raw of cases) {
      const config = testConfig();
      const path = join(config.home, "settings.json");
      writeFileSync(path, raw);
      await run(config, async (s) => {
        expect(s.agora()).toBeUndefined();
        // A save after it writes a new file; the one set aside keeps the user's bytes.
        await s.save({ dictation: { via: "own", url: "http://127.0.0.1:1/v1", model: "m" } });
      });
      const kept = readdirSync(config.home).filter((f) => f.startsWith("settings.json.unreadable-"));
      expect(kept).toHaveLength(1);
      expect(readFileSync(join(config.home, kept[0]!), "utf8")).toBe(raw);
    }
  });
});
