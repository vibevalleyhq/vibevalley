import { join } from "node:path";

import { Context, Effect, Layer, Predicate, Schema, Semaphore } from "effect";

import { t, setLocale } from "@vibevalley/i18n";
import type { Validation, KeySource, KeyStatus, SettingsStatus, SettingsUpdate, VoiceSettings } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { pkmDir, reposDir, ServerConfig, worktreesDir } from "#/infra/config.ts";
import { keptFile, readOrSetAside } from "#/infra/files.ts";

import { keyHint, memorySourcesOver, settingsProblem } from "./memorySources.ts";
import { boundConnection, emptyProviders, ProviderSettings } from "./provider.ts";
import { defaultVoice, voiceOverrides, voiceSettingsOver } from "./voice.ts";

const MemorySourceConfig = Schema.Struct({
  kind: S.MemorySourceKind,
  url: Schema.String,
  enabled: Schema.optionalKey(Schema.Boolean),
  read: Schema.optionalKey(Schema.Boolean),
  write: Schema.optionalKey(Schema.Boolean),
  everything: Schema.optionalKey(Schema.Boolean),
  user: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
});
type MemorySourceConfig = typeof MemorySourceConfig.Type;

/** MOSS is dictation's default, so only the owner's own address is written as a choice. */
const StoredDictation = Schema.Struct({
  via: Schema.optionalKey(Schema.Literal("own")),
  url: Schema.String,
  model: Schema.String,
});

/** settings.json, in the order the file has it. */
const Stored = Schema.Struct({
  locale: Schema.optionalKey(S.Locale),
  deepseekApiKey: Schema.optionalKey(Schema.String),
  agoraAppId: Schema.optionalKey(Schema.String),
  agoraAppCertificate: Schema.optionalKey(Schema.String),
  asrKey: Schema.optionalKey(Schema.String),
  llmKey: Schema.optionalKey(Schema.String),
  ttsKey: Schema.optionalKey(Schema.String),
  voice: Schema.optionalKey(S.SettingsUpdateVoice),
  dictationKey: Schema.optionalKey(Schema.String),
  dictation: Schema.optionalKey(StoredDictation),
  providers: Schema.optionalKey(ProviderSettings),
  memorySources: Schema.optionalKey(Schema.Array(MemorySourceConfig)),
});
type Stored = typeof Stored.Type;

export interface VoiceKeys {
  readonly asrKey: string;
  readonly llmKey: string;
  readonly ttsKey: string;
}

/** One settings revision: the voice's providers and their keys belong together. */
interface VoiceConfig {
  readonly voice: VoiceSettings;
  readonly keys: VoiceKeys;
  readonly deepseekApiKey: string;
}

/** Read together, so an address is never paired with another one's key. */
type DictationConfig = { readonly via: "moss" } | { readonly via: "own"; readonly url: string; readonly model: string; readonly key: string };

export interface AgoraCredentials {
  readonly appId: string;
  readonly appCertificate: string;
}

export class SettingRefused extends Schema.TaggedError<SettingRefused, { readonly brand: unique symbol }>()("SettingRefused", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export class Setting extends Context.Service<
  Setting,
  {
    readonly status: () => SettingsStatus;
    readonly validate: (u: SettingsUpdate) => Validation;
    /** A key missing from the update is kept, an empty one cleared; nothing is saved when something cannot be right. */
    readonly save: (u: SettingsUpdate) => Effect.Effect<SettingsStatus, SettingRefused>;
    readonly deepseekApiKey: () => string;
    readonly agora: () => AgoraCredentials | undefined;
    readonly voice: () => VoiceSettings;
    /** Undefined when the owner's own address is chosen and not set. */
    readonly dictation: () => DictationConfig | undefined;
    readonly providers: () => ProviderSettings;
    readonly updateProviders: (
      change: (current: ProviderSettings) => Effect.Effect<ProviderSettings, SettingRefused>,
    ) => Effect.Effect<ProviderSettings, SettingRefused>;
    readonly memorySources: () => readonly MemorySourceConfig[];
    readonly voiceConfig: () => VoiceConfig;
  }
>()("@vibevalley/server/setting/setting") {
  static readonly layer = Layer.effect(
    Setting,
    Effect.suspend(() => make),
  );
}

const secret = (value: string | undefined, source: KeySource): KeyStatus => (value ? { source, hint: keyHint(value) } : { source: null });

/** Fields set to "" or nothing leave the file. */
const compact = (s: Record<string, unknown>) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== ""));

/** As it is written: keys in the order they were set. */
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const file = join(config.home, "settings.json");
  const disk = yield* keptFile(file, { mode: 0o600 });
  const saving = yield* Semaphore.make(1);
  const fromConfig = { deepseek: config.deepseek.apiKey, appId: config.agora.appId, certificate: config.agora.appCertificate };
  // Reset to defaults goes back to these.
  // In the farm's language, as it is when asked: the persona, greeting and failure line are words.
  const defaults = (): VoiceSettings => {
    const base = defaultVoice();
    if (!config.voice.id) return base;
    return { ...base, tts: { vendor: "minimax", model: base.tts.vendor === "minimax" ? base.tts.model : "speech_2_6_turbo", voiceId: config.voice.id } };
  };
  let stored: Stored = (yield* readOrSetAside(file, Schema.decodeEffect(Schema.fromJsonString(Stored)), "the settings start empty")) ?? {};
  setLocale(stored.locale ?? "zh");

  const pick = (saved: string | undefined, given: string): [string, KeySource] | undefined =>
    saved ? [saved, "settings"] : given ? [given, "config"] : undefined;
  const voiceOf = (s: Stored) => (s.voice ? voiceSettingsOver(defaults(), s.voice) : defaults());

  const status = (): SettingsStatus => {
    const s = stored;
    const deepseek = pick(s.deepseekApiKey, fromConfig.deepseek);
    const appId = pick(s.agoraAppId, fromConfig.appId);
    const certificate = pick(s.agoraAppCertificate, fromConfig.certificate);
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
      dictationReady:
        s.dictation?.via === "own" ? !!s.dictation.url : !!boundConnection(s.providers ?? emptyProviders, s.providers?.dictation?.connection ?? null),
      mossReady: !!boundConnection(s.providers ?? emptyProviders, s.providers?.live?.connection ?? null),
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

  // Once the rename starts, cancellation must not leave memory at the previous revision.
  const persist = Effect.fn("Setting.persist")(function* (next: Stored) {
    yield* encodeStored(next).pipe(
      Effect.flatMap((text) => disk.save(text + "\n")),
      Effect.mapError((e) => SettingRefused.make({ message: t("server.setting.notSaved", { file, why: e.message }), cause: e })),
    );
    stored = next;
    setLocale(next.locale ?? "zh");
  }, Effect.uninterruptible);

  const save = Effect.fn("Setting.save")(function* (u: SettingsUpdate) {
    const problem = settingsProblem(u);
    if (problem) return yield* SettingRefused.make({ message: problem });
    const next: Record<string, unknown> = { ...stored };
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
    if (u.memorySources) next.memorySources = memorySourcesOver(stored.memorySources ?? [], u.memorySources);
    if (u.voice) next.voice = voiceOverrides(defaults(), voiceSettingsOver(defaults(), u.voice));
    if (Predicate.isObject(next.voice) && Object.keys(next.voice).length === 0) next.voice = undefined;
    if (Array.isArray(next.memorySources) && next.memorySources.length === 0) next.memorySources = undefined;
    const kept = yield* Schema.decodeEffect(Stored)(compact(next)).pipe(Effect.mapError((e) => SettingRefused.make({ message: e.message, cause: e })));
    yield* persist(kept);
    return status();
  }, saving.withPermits(1));

  const shape = Setting.of({
    status,
    validate: (u) => ({ problem: settingsProblem(u) }),
    save,
    deepseekApiKey: () => pick(stored.deepseekApiKey, fromConfig.deepseek)?.[0] ?? "",
    agora: () => {
      const appId = pick(stored.agoraAppId, fromConfig.appId)?.[0];
      const appCertificate = pick(stored.agoraAppCertificate, fromConfig.certificate)?.[0];
      return appId && appCertificate ? { appId, appCertificate } : undefined;
    },
    voice: () => voiceOf(stored),
    dictation: () => {
      const d = stored.dictation;
      if (d?.via !== "own") return { via: "moss" };
      return d.url ? { via: "own", url: d.url, model: d.model, key: stored.dictationKey ?? "" } : undefined;
    },
    providers: () => stored.providers ?? emptyProviders,
    updateProviders: Effect.fn("Setting.updateProviders")(function* (change) {
      const next = yield* change(stored.providers ?? emptyProviders);
      yield* persist({ ...stored, providers: next });
      return next;
    }, saving.withPermits(1)),
    memorySources: () => [...(stored.memorySources ?? [])],
    voiceConfig: () => ({
      voice: voiceOf(stored),
      keys: { asrKey: stored.asrKey ?? "", llmKey: stored.llmKey ?? "", ttsKey: stored.ttsKey ?? "" },
      deepseekApiKey: pick(stored.deepseekApiKey, fromConfig.deepseek)?.[0] ?? "",
    }),
  });
  return shape;
});
