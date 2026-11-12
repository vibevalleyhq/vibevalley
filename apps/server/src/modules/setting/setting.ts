import { join } from "node:path";

import { z } from "zod";

import { Semaphore } from "@vibevalley/async";
import { t, setLocale } from "@vibevalley/i18n";
import type { Validation, KeySource, KeyStatus, SettingsStatus, SettingsUpdate, VoiceSettings } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";
import { Secret } from "@vibevalley/protocol/schema";

import { BizCode, bizError, messageOf } from "#/base/errors.ts";
import { jsonOf, problemOf } from "#/base/json.ts";
import { pkmDir, reposDir, type ServerConfig, worktreesDir } from "#/infra/config.ts";
import { keptFile, readOrSetAside } from "#/infra/files.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";

import { keyHint, memorySourcesOver, settingsProblem } from "./memorySources.ts";
import { emptyProviders, ProviderSettings, StoredKey } from "./provider.ts";
import { readinessOf } from "./readiness.ts";
import { defaultVoice, voiceOverrides, voiceSettingsOver } from "./voice.ts";

const MemorySourceConfig = z.object({
  kind: S.MemorySourceKind,
  url: z.string(),
  enabled: z.exactOptional(z.boolean()),
  read: z.exactOptional(z.boolean()),
  write: z.exactOptional(z.boolean()),
  everything: z.exactOptional(z.boolean()),
  user: z.exactOptional(z.string()),
  key: z.exactOptional(StoredKey),
});
type MemorySourceConfig = z.output<typeof MemorySourceConfig>;

/** MOSS is dictation's default, so only the user's own address is written as a choice. */
const StoredDictation = z.object({
  via: z.exactOptional(z.literal("own")),
  url: z.string(),
  model: z.string(),
});

/** A key: a plain string in settings.json, a Secret in memory until a call sends it. */
const Key = z.exactOptional(StoredKey);

/** settings.json, in the order the file has it. */
const Stored = z.object({
  locale: z.exactOptional(S.Locale),
  deepseekApiKey: Key,
  agoraAppId: z.exactOptional(z.string()),
  agoraAppCertificate: Key,
  asrKey: Key,
  llmKey: Key,
  ttsKey: Key,
  voice: z.exactOptional(S.SettingsUpdateVoice),
  dictationKey: Key,
  dictation: z.exactOptional(StoredDictation),
  providers: z.exactOptional(ProviderSettings),
  memorySources: z.exactOptional(z.array(MemorySourceConfig)),
});
type Stored = z.output<typeof Stored>;

/** The call vendors' keys; an empty one is not set. */
interface VoiceKeys {
  readonly asrKey: Secret;
  readonly llmKey: Secret;
  readonly ttsKey: Secret;
}

/** One settings revision: the voice's providers and their keys belong together. */
interface VoiceConfig {
  readonly voice: VoiceSettings;
  readonly keys: VoiceKeys;
  readonly deepseekApiKey: Secret | undefined;
}

/** Read together, so an address is never paired with another one's key. */
type DictationConfig = { readonly via: "moss" } | { readonly via: "own"; readonly url: string; readonly model: string; readonly key: Secret };

export interface AgoraCredentials {
  readonly appId: string;
  readonly appCertificate: Secret;
}

export interface Setting {
  readonly status: () => SettingsStatus;
  readonly validate: (u: SettingsUpdate) => Validation;
  /** A key missing from the update is kept, an empty one cleared; nothing is saved when something cannot be right. */
  readonly save: (u: SettingsUpdate) => Promise<SettingsStatus>;
  /** Undefined when neither settings nor the startup config has one. */
  readonly deepseekApiKey: () => Secret | undefined;
  readonly agora: () => AgoraCredentials | undefined;
  readonly voice: () => VoiceSettings;
  /** Undefined when the user's own address is chosen and not set. */
  readonly dictation: () => DictationConfig | undefined;
  readonly providers: () => ProviderSettings;
  /** change runs under the settings' lock, on the providers as they are then; what it throws is thrown and nothing is saved. */
  readonly updateProviders: (change: (current: ProviderSettings) => ProviderSettings | Promise<ProviderSettings>) => Promise<ProviderSettings>;
  readonly memorySources: () => readonly MemorySourceConfig[];
  readonly voiceConfig: () => VoiceConfig;
  /** The settings file's pending write, now. */
  readonly close: () => Promise<void>;
}

export interface SettingDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
}

const secret = (value: Secret | undefined, source: KeySource): KeyStatus =>
  value !== undefined && value.reveal() !== "" ? { source, hint: keyHint(value.reveal()) } : { source: null };
/** A key as the vendor gets it: an empty one when none is set. */
const keyOrEmpty = (value: Secret | undefined) => value ?? new Secret("");

/** Fields set to "" or nothing leave the file. */
const compact = (s: Record<string, unknown>) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== ""));

/** As it is written: the keys as plain strings, as they were typed. */
const storedText = (s: Stored) => JSON.stringify(z.encode(Stored, s), null, 2);
/** The file's fields before decoding: keys as plain strings, so an update can be laid over them. */
const plainStored = (s: Stored) => z.encode(Stored, s);

export async function makeSetting(deps: SettingDeps): Promise<Setting> {
  const { config } = deps;
  const log = deps.log.child("setting");
  const file = join(config.home, "settings.json");
  const disk = keptFile(file, { clock: deps.clock, log }, { mode: 0o600 });
  const saving = new Semaphore(1);
  const fromConfig = { deepseek: config.deepseek.apiKey, appId: config.agora.appId, certificate: config.agora.appCertificate };
  // Reset to defaults goes back to these.
  // In the farm's language, as it is when asked: the persona, greeting and failure line are words.
  const defaults = (): VoiceSettings => {
    const base = defaultVoice();
    if (!config.voice.id) return base;
    return { ...base, tts: { vendor: "minimax", model: base.tts.vendor === "minimax" ? base.tts.model : "speech_2_6_turbo", voiceId: config.voice.id } };
  };
  let stored: Stored = (await readOrSetAside(file, jsonOf(Stored), "the settings start empty", { clock: deps.clock, log })) ?? {};
  setLocale(stored.locale ?? "zh");

  const pick = (saved: string | undefined, given: string): [string, KeySource] | undefined =>
    saved ? [saved, "settings"] : given ? [given, "config"] : undefined;
  const pickKey = (saved: Secret | undefined, given: Secret): [Secret, KeySource] | undefined =>
    saved !== undefined && saved.reveal() !== "" ? [saved, "settings"] : given.reveal() !== "" ? [given, "config"] : undefined;
  const voiceOf = (s: Stored) => (s.voice ? voiceSettingsOver(defaults(), s.voice) : defaults());

  const status = (): SettingsStatus => {
    const s = stored;
    const deepseek = pickKey(s.deepseekApiKey, fromConfig.deepseek);
    const appId = pick(s.agoraAppId, fromConfig.appId);
    const certificate = pickKey(s.agoraAppCertificate, fromConfig.certificate);
    return {
      file,
      home: config.home,
      paths: { repos: reposDir(config), worktrees: worktreesDir(config), pkm: pkmDir(config) },
      version: config.version,
      locale: s.locale ?? "zh",
      deepseekApiKey: deepseek ? secret(deepseek[0], deepseek[1]) : { source: null },
      agoraAppId: appId ? { source: appId[1], value: appId[0] } : { source: null },
      agoraAppCertificate: certificate ? secret(certificate[0], certificate[1]) : { source: null },
      voice: voiceOf(s),
      voiceDefaults: defaults(),
      asrKey: secret(s.asrKey, "settings"),
      llmKey: secret(s.llmKey, "settings"),
      ttsKey: secret(s.ttsKey, "settings"),
      dictation: { via: s.dictation?.via ?? "moss", url: s.dictation?.url ?? "", model: s.dictation?.model ?? "" },
      dictationKey: secret(s.dictationKey, "settings"),
      readiness: readinessOf({
        providers: s.providers ?? emptyProviders,
        deepseekKey: deepseek !== undefined,
        agora: appId !== undefined && certificate !== undefined,
        dictation: { via: s.dictation?.via ?? "moss", url: s.dictation?.url ?? "" },
        callAnswer: voiceOf(s).answer.vendor,
      }),
      memorySources: (s.memorySources ?? []).map(({ key, ...m }) => ({
        ...m,
        everything: m.everything ?? false,
        enabled: !(m.enabled !== true),
        read: !(m.read !== true),
        write: !(m.write !== true),
        key: secret(key, "settings"),
      })),
    };
  };

  // Not given a signal: once the rename starts, memory must not stay at the previous revision.
  const persist = async (next: Stored) => {
    try {
      await disk.save(storedText(next) + "\n");
    } catch (e) {
      throw bizError(BizCode.SettingRefused, t("server.setting.notSaved", { file, why: messageOf(e) }));
    }
    stored = next;
    setLocale(next.locale ?? "zh");
  };

  const save = (u: SettingsUpdate) =>
    saving.with(async () => {
      const problem = settingsProblem(u);
      if (problem) throw bizError(BizCode.SettingRefused, problem);
      const plain = plainStored(stored);
      const next: Record<string, unknown> = { ...plain };
      for (const key of ["deepseekApiKey", "agoraAppId", "agoraAppCertificate", "asrKey", "llmKey", "ttsKey", "dictationKey"] as const) {
        const given = u[key];
        if (given !== undefined) next[key] = given.trim();
      }
      if (u.locale) next.locale = u.locale === "zh" ? undefined : u.locale;
      if (u.dictation) {
        const d = {
          ...(u.dictation.via === "own" ? { via: "own" as const } : {}),
          url: u.dictation.url.trim().replace(/\/+$/u, ""),
          model: u.dictation.model.trim(),
        };
        next.dictation = !d.via && d.url === "" && d.model === "" ? undefined : d;
      }
      if (u.memorySources) next.memorySources = memorySourcesOver(plain.memorySources ?? [], u.memorySources);
      if (u.voice) next.voice = voiceOverrides(defaults(), voiceSettingsOver(defaults(), u.voice));
      if (typeof next.voice === "object" && next.voice !== null && Object.keys(next.voice).length === 0) next.voice = undefined;
      if (Array.isArray(next.memorySources) && next.memorySources.length === 0) next.memorySources = undefined;
      const kept = Stored.safeParse(compact(next));
      if (!kept.success) throw bizError(BizCode.SettingRefused, problemOf(kept.error));
      await persist(kept.data);
      return status();
    });

  return {
    status,
    validate: (u) => ({ problem: settingsProblem(u) }),
    save,
    deepseekApiKey: () => pickKey(stored.deepseekApiKey, fromConfig.deepseek)?.[0],
    agora: () => {
      const appId = pick(stored.agoraAppId, fromConfig.appId)?.[0];
      const appCertificate = pickKey(stored.agoraAppCertificate, fromConfig.certificate)?.[0];
      return appId !== undefined && appCertificate !== undefined ? { appId, appCertificate } : undefined;
    },
    voice: () => voiceOf(stored),
    dictation: () => {
      const d = stored.dictation;
      if (d?.via !== "own") return { via: "moss" };
      return d.url ? { via: "own", url: d.url, model: d.model, key: keyOrEmpty(stored.dictationKey) } : undefined;
    },
    providers: () => stored.providers ?? emptyProviders,
    updateProviders: (change) =>
      saving.with(async () => {
        const next = await change(stored.providers ?? emptyProviders);
        await persist({ ...stored, providers: next });
        return next;
      }),
    memorySources: () => [...(stored.memorySources ?? [])],
    voiceConfig: () => ({
      voice: voiceOf(stored),
      keys: { asrKey: keyOrEmpty(stored.asrKey), llmKey: keyOrEmpty(stored.llmKey), ttsKey: keyOrEmpty(stored.ttsKey) },
      deepseekApiKey: pickKey(stored.deepseekApiKey, fromConfig.deepseek)?.[0],
    }),
    close: () => disk.close(),
  };
}
