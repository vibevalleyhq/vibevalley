// The owner's settings: settings.json in the home, readable by the owner only
// (0600). A key saved here wins over the configuration's. Keys are read each time they are used, so one saved is used at
// once; a page sees only where each comes from and its last characters; keys are never logged.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Dictation, KeySource, KeyStatus, SettingsCheck, SettingsStatus, SettingsUpdate, SettingsUpdateVoice, VoiceSettings } from "@vibevalley/protocol";
import { defaultVoice, keyHint, type MemorySourceConfig, memorySourcesOver, settingsProblem, voiceOverrides, voiceSettingsOver } from "./rules.ts";
import { Context, Effect, Layer } from "effect";
import { Settings } from "../base/config.ts";
import { FileWriter } from "../base/files.ts";

/** settings.json, in the order the file has it. */
interface Stored {
  readonly deepseekApiKey?: string;
  readonly agoraAppId?: string;
  readonly agoraAppCertificate?: string;
  readonly asrKey?: string;
  readonly llmKey?: string;
  readonly ttsKey?: string;
  readonly voice?: SettingsUpdateVoice;
  readonly dictationKey?: string;
  readonly dictation?: Dictation;
  readonly memorySources?: readonly MemorySourceConfig[];
}

export interface VoiceKeys {
  readonly asrKey: string;
  readonly llmKey: string;
  readonly ttsKey: string;
}

/** One settings revision: the voice's providers and their keys belong together. */
export interface VoiceConfig {
  readonly voice: VoiceSettings;
  readonly keys: VoiceKeys;
  readonly deepseekApiKey: string;
}

/** Read together, so an address is never paired with another one's key. */
export interface DictationConfig extends Dictation {
  readonly key: string;
}

export interface AgoraCredentials {
  readonly appId: string;
  readonly appCertificate: string;
}

export class SettingRefused extends Error {}

export interface SettingShape {
  readonly status: () => SettingsStatus;
  readonly check: (u: SettingsUpdate) => SettingsCheck;
  /** A key missing from the update is kept, an empty one cleared; nothing is saved when something cannot be right. */
  readonly save: (u: SettingsUpdate) => Effect.Effect<SettingsStatus, SettingRefused>;
  readonly deepseekApiKey: () => string;
  readonly agora: () => AgoraCredentials | undefined;
  readonly voice: () => VoiceSettings;
  /** Undefined when no address is set. */
  readonly dictation: () => DictationConfig | undefined;
  readonly memorySources: () => readonly MemorySourceConfig[];
  readonly voiceConfig: () => VoiceConfig;
}

export class Setting extends Context.Service<Setting, SettingShape>()("vibevalley/Setting") {}

const read = (file: string): Stored => {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Stored) : {};
  } catch {
    return {};
  }
};

const secret = (value: string | undefined, source: KeySource): KeyStatus => (value ? { source, hint: keyHint(value) } : {});

/** Fields set to "" or nothing leave the file. */
const compact = (s: Record<string, unknown>) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== ""));

export const make = Effect.gen(function* () {
  const config = yield* Settings;
  const file = join(config.home, "settings.json");
  const disk = new FileWriter(file, 0o600);
  const fromConfig = { deepseek: config.deepseek.apiKey, appId: config.agora.appId, certificate: config.agora.appCertificate };
  // 恢复默认 goes back to these.
  let defaults = defaultVoice();
  if (config.voice.id) {
    const tts = defaultVoice().tts;
    defaults = { ...defaults, tts: { vendor: "minimax", model: tts.vendor === "minimax" ? tts.model : "speech_2_6_turbo", voiceId: config.voice.id } };
  }
  let stored = read(file);

  const pick = (saved: string | undefined, given: string): [string, KeySource] | undefined =>
    saved ? [saved, "settings"] : given ? [given, "config"] : undefined;
  const voiceOf = (s: Stored) => (s.voice ? voiceSettingsOver(defaults, s.voice) : defaults);

  const status = (): SettingsStatus => {
    const s = stored;
    const deepseek = pick(s.deepseekApiKey, fromConfig.deepseek);
    const appId = pick(s.agoraAppId, fromConfig.appId);
    const certificate = pick(s.agoraAppCertificate, fromConfig.certificate);
    return {
      file,
      deepseekApiKey: deepseek ? secret(deepseek[0], deepseek[1]) : {},
      agoraAppId: appId ? { source: appId[1], value: appId[0] } : {},
      agoraAppCertificate: certificate ? secret(certificate[0], certificate[1]) : {},
      voice: voiceOf(s),
      voiceDefaults: defaults,
      asrKey: secret(s.asrKey, "settings"),
      llmKey: secret(s.llmKey, "settings"),
      ttsKey: secret(s.ttsKey, "settings"),
      dictation: s.dictation ?? { url: "", model: "" },
      dictationKey: secret(s.dictationKey, "settings"),
      memorySources: (s.memorySources ?? []).map(({ key, ...m }) => ({
        ...m,
        enabled: !!m.enabled,
        read: !!m.read,
        write: !!m.write,
        key: secret(key, "settings"),
      })),
    };
  };

  const save = Effect.fn("Setting.save")(function* (u: SettingsUpdate) {
    const problem = settingsProblem(u);
    if (problem) return yield* Effect.fail(new SettingRefused(problem));
    const next: Record<string, unknown> = { ...stored };
    for (const key of ["deepseekApiKey", "agoraAppId", "agoraAppCertificate", "asrKey", "llmKey", "ttsKey", "dictationKey"] as const) {
      const given = u[key];
      if (given !== undefined) next[key] = given.trim();
    }
    if (u.dictation) {
      const d = { url: u.dictation.url.trim().replace(/\/+$/, ""), model: u.dictation.model.trim() };
      next.dictation = d.url === "" && d.model === "" ? undefined : d;
    }
    if (u.memorySources) next.memorySources = memorySourcesOver(stored.memorySources ?? [], u.memorySources);
    if (u.voice) next.voice = voiceOverrides(defaults, voiceSettingsOver(defaults, u.voice));
    if (next.voice && Object.keys(next.voice).length === 0) next.voice = undefined;
    if (Array.isArray(next.memorySources) && next.memorySources.length === 0) next.memorySources = undefined;
    const kept = compact(next) as Stored;
    try {
      disk.write(() => JSON.stringify(kept, null, 2) + "\n");
    } catch (e) {
      return yield* Effect.fail(new SettingRefused(`存不进 ${file}：${(e as Error).message}`));
    }
    stored = kept;
    return status();
  });

  const shape: SettingShape = {
    status,
    check: (u) => {
      const problem = settingsProblem(u);
      return problem ? { problem } : {};
    },
    save,
    deepseekApiKey: () => pick(stored.deepseekApiKey, fromConfig.deepseek)?.[0] ?? "",
    agora: () => {
      const appId = pick(stored.agoraAppId, fromConfig.appId)?.[0];
      const appCertificate = pick(stored.agoraAppCertificate, fromConfig.certificate)?.[0];
      return appId && appCertificate ? { appId, appCertificate } : undefined;
    },
    voice: () => voiceOf(stored),
    dictation: () => (stored.dictation?.url ? { ...stored.dictation, key: stored.dictationKey ?? "" } : undefined),
    memorySources: () => [...(stored.memorySources ?? [])],
    voiceConfig: () => ({
      voice: voiceOf(stored),
      keys: { asrKey: stored.asrKey ?? "", llmKey: stored.llmKey ?? "", ttsKey: stored.ttsKey ?? "" },
      deepseekApiKey: pick(stored.deepseekApiKey, fromConfig.deepseek)?.[0] ?? "",
    }),
  };
  return shape;
});

export const layer = Layer.effect(Setting, make);
