import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { type Config, Settings } from "../base/config.ts";
import { Effect, Layer } from "effect";
import { defaultVoice } from "./rules.ts";
import { testConfig } from "../testing/layers.ts";
import { layer, Setting } from "./setting.ts";

const appId = "11111111111111111111111111111111";
const cert = "22222222222222222222222222222222";

const run = <A, E>(config: Config, body: Effect.Effect<A, E, Setting>) => body.pipe(Effect.provide(layer.pipe(Layer.provide(Layer.succeed(Settings, config)))));
const file = (config: Config) => JSON.parse(readFileSync(join(config.home, "settings.json"), "utf8")) as Record<string, unknown>;

describe("settings", () => {
  it.effect("a key saved here wins over the configuration's, and only its end is ever shown", () => {
    const config = testConfig({ deepseek: { apiKey: "sk-from-the-env-0000" } });
    return run(
      config,
      Effect.gen(function* () {
        const s = yield* Setting;
        expect(s.status().deepseekApiKey).toEqual({ source: "config", hint: "…0000" });
        expect(s.status().agoraAppId).toEqual({});
        const after = yield* s.save({ deepseekApiKey: " sk-saved-in-settings-1234 ", agoraAppId: appId, agoraAppCertificate: cert });
        expect(after.deepseekApiKey).toEqual({ source: "settings", hint: "…1234" });
        expect(after.agoraAppId).toEqual({ source: "settings", value: appId });
        expect(after.agoraAppCertificate).toEqual({ source: "settings", hint: "…2222" });
        expect(JSON.stringify(after)).not.toContain("sk-saved");
        expect(s.deepseekApiKey()).toBe("sk-saved-in-settings-1234");
        expect(s.agora()).toEqual({ appId, appCertificate: cert });
        expect(statSync(join(config.home, "settings.json")).mode & 0o777).toBe(0o600);
        expect(file(config)).toEqual({ deepseekApiKey: "sk-saved-in-settings-1234", agoraAppId: appId, agoraAppCertificate: cert });
        const cleared = yield* s.save({ deepseekApiKey: "" });
        expect(cleared.deepseekApiKey).toEqual({ source: "config", hint: "…0000" });
        expect(cleared.agoraAppId.value).toBe(appId);
        expect(file(config)).not.toHaveProperty("deepseekApiKey");
      }),
    ).pipe(
      Effect.andThen(
        run(
          config,
          Effect.map(Setting, (again) => expect(again.agora()?.appId).toBe(appId)),
        ),
      ),
    );
  });

  it.effect("nothing is saved when something cannot be right", () =>
    run(
      testConfig(),
      Effect.gen(function* () {
        const s = yield* Setting;
        const refused = yield* s.save({ agoraAppId: "not-an-app-id" }).pipe(Effect.flip);
        expect(refused.message).toMatch(/App ID/);
        expect(s.agora()).toBeUndefined();
      }),
    ),
  );

  it.effect("the voice keeps only what differs from its defaults, which the configuration sets", () => {
    const config = testConfig({ voice: { id: "English_captivating_female1", line: { port: 0, url: "" } } });
    return run(
      config,
      Effect.gen(function* () {
        const s = yield* Setting;
        const before = s.status();
        expect(before.voiceDefaults.answer).toEqual({ vendor: "orchestrator" });
        expect(before.voiceDefaults.tts).toEqual({ vendor: "minimax", model: "speech_2_6_turbo", voiceId: "English_captivating_female1" });
        expect(before.voiceDefaults.greeting).toBe(defaultVoice().greeting);
        expect(before.voice).toEqual(before.voiceDefaults);
        const wanted = { ...before.voiceDefaults, area: "CN" as const, silenceMs: 600, greeting: "在呢。" };
        expect((yield* s.save({ voice: { area: "CN", silenceMs: 600, greeting: "在呢。" } })).voice).toEqual(wanted);
        expect(s.voice()).toEqual(wanted);
        expect(file(config).voice).toEqual({ area: "CN", silenceMs: 600, greeting: "在呢。" });
        // The page sends the voice whole: what equals the defaults is left out all the same.
        yield* s.save({ voice: wanted });
        expect(file(config).voice).toEqual({ area: "CN", silenceMs: 600, greeting: "在呢。" });
        expect(s.check({ voice: { persona: "  " } }).problem).toBeTruthy();
        yield* s.save({ agoraAppId: appId });
        expect(s.voice().area).toBe("CN");
        const reset = yield* s.save({ voice: {} });
        expect(reset.voice).toEqual(reset.voiceDefaults);
        expect(file(config)).not.toHaveProperty("voice");
        expect((yield* s.save({ voice: { silenceMs: 50 } }).pipe(Effect.flip)).message).toMatch(/200 到 2000/);
      }),
    );
  });

  it.effect("a voice vendor's key is a hint", () => {
    const config = testConfig();
    return run(
      config,
      Effect.gen(function* () {
        const s = yield* Setting;
        expect(s.status().ttsKey).toEqual({});
        const tts = { vendor: "microsoft", region: "eastasia", voiceName: "zh-CN-XiaoxiaoNeural" } as const;
        const after = yield* s.save({ voice: { tts }, ttsKey: " azure-speech-key-9f3a " });
        expect(after.voice.tts).toEqual(tts);
        expect(after.ttsKey).toEqual({ source: "settings", hint: "…9f3a" });
        expect(JSON.stringify(after)).not.toContain("azure-speech-key");
        expect(s.voiceConfig().keys).toEqual({ asrKey: "", llmKey: "", ttsKey: "azure-speech-key-9f3a" });
        expect(file(config).voice).toEqual({ tts });
      }),
    );
  });

  it.effect("a memory source keeps its key until cleared", () => {
    const config = testConfig();
    const nowledge = { kind: "nowledge", url: " http://127.0.0.1:14242/mcp/ ", enabled: true, read: true, write: true, key: "nmem-secret-9876" } as const;
    return run(
      config,
      Effect.gen(function* () {
        const s = yield* Setting;
        expect(s.status().memorySources).toEqual([]);
        expect((yield* s.save({ memorySources: [nowledge] })).memorySources[0]!.key).toEqual({ source: "settings", hint: "…9876" });
        yield* s.save({ memorySources: [{ ...nowledge, key: undefined, write: false }] });
        expect(s.memorySources()).toEqual([{ kind: "nowledge", url: "http://127.0.0.1:14242/mcp/", enabled: true, read: true, key: "nmem-secret-9876" }]);
        yield* s.save({ deepseekApiKey: "sk-other-key-0000" });
        expect(s.memorySources()).toHaveLength(1);
        yield* s.save({ memorySources: [] });
        expect(s.memorySources()).toEqual([]);
      }),
    );
  });

  it.effect("an unreadable or invalid settings file is kept aside untouched, and the settings start empty", () =>
    Effect.gen(function* () {
      const cases = ["{not json", JSON.stringify({ deepseekApiKey: 7, agoraAppId: appId })];
      for (const raw of cases) {
        const config = testConfig();
        const path = join(config.home, "settings.json");
        writeFileSync(path, raw);
        yield* run(
          config,
          Effect.gen(function* () {
            const s = yield* Setting;
            expect(s.agora()).toBeUndefined();
            // A save after it writes a new file; the one set aside keeps the owner's bytes.
            yield* s.save({ dictation: { url: "http://127.0.0.1:1/v1", model: "m" } });
          }),
        );
        const kept = readdirSync(config.home).filter((f) => f.startsWith("settings.json.unreadable-"));
        expect(kept).toHaveLength(1);
        expect(readFileSync(join(config.home, kept[0]!), "utf8")).toBe(raw);
      }
    }),
  );
});
