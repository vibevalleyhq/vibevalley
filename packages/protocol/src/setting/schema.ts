import { z } from "zod";

import type { Codec } from "../codec";
import { KeyStatus, Locale } from "../common/schema";
import { SettingsUpdateVoice, VoiceSettings } from "../voice/schema";
import * as T from "./shapes.gen";

export const MemorySourceInfo = z.object({
  name: z.string(),
  label: z.string(),
  on: z.boolean(),
  off: z.string(),
  canList: z.boolean(),
  canForget: z.boolean(),
  transcripts: z.boolean(),
}) satisfies Codec<T.MemorySourceInfo>;

export const MemorySourceKind = z.enum(T.MemorySourceKindValues) satisfies Codec<T.MemorySourceKind>;

const MemorySource = z.object({
  kind: MemorySourceKind,
  url: z.string(),
  enabled: z.boolean(),
  read: z.boolean(),
  write: z.boolean(),
  everything: z.boolean(),
  user: z.exactOptional(z.string()),
  key: KeyStatus,
}) satisfies Codec<T.MemorySource>;

const SpacePaths = z.object({
  repos: z.string(),
  worktrees: z.string(),
}) satisfies Codec<T.SpacePaths>;

const Readiness = z.discriminatedUnion("ready", [
  z.object({ ready: z.literal(true) }),
  z.object({ ready: z.literal(false), missing: z.enum(T.MissingValues) }),
]) satisfies Codec<T.Readiness>;

export const UserProfile = z.object({
  displayName: z.exactOptional(z.string()),
  avatarAttachmentId: z.exactOptional(z.string()),
  avatarPreset: z.exactOptional(z.string()),
  tagline: z.exactOptional(z.string()),
}) satisfies Codec<T.UserProfile>;

export const SettingsStatus = z.object({
  file: z.string(),
  home: z.string(),
  paths: SpacePaths,
  version: z.string(),
  locale: Locale,
  deepseekApiKey: KeyStatus,
  voice: VoiceSettings,
  voiceDefaults: VoiceSettings,
  readiness: z.record(z.enum(T.FeatureValues), Readiness),
  memorySources: z.array(MemorySource),
  profile: z.exactOptional(UserProfile),
  storageBackend: z.exactOptional(z.string()),
}) satisfies Codec<T.SettingsStatus>;

const MemorySourceUpdate = z.object({
  kind: MemorySourceKind,
  url: z.string(),
  enabled: z.boolean(),
  read: z.boolean(),
  write: z.boolean(),
  everything: z.exactOptional(z.boolean()),
  user: z.exactOptional(z.string()),
  key: z.exactOptional(z.string()),
}) satisfies Codec<T.MemorySourceUpdate>;

export const SettingsUpdate = z.object({
  locale: z.exactOptional(Locale),
  deepseekApiKey: z.exactOptional(z.string()),
  voice: z.exactOptional(SettingsUpdateVoice),
  memorySources: z.exactOptional(z.array(MemorySourceUpdate)),
  profile: z.exactOptional(UserProfile),
}) satisfies Codec<T.SettingsUpdate>;
