import { z } from "zod";

import type { Codec } from "../codec";
import * as T from "./shapes";

export const CallState = z.enum(T.CallStateValues) satisfies Codec<T.CallState>;

export const VoiceCall = z.object({
  agentId: z.string(),
}) satisfies Codec<T.VoiceCall>;

export const VoiceGrant = z.object({
  channel: z.string(),
  uid: z.string(),
}) satisfies Codec<T.VoiceGrant>;

export const VoiceSettings = z.object({
  persona: z.string(),
  greeting: z.string(),
}) satisfies Codec<T.VoiceSettings>;

export const SettingsUpdateVoice = z.object({
  persona: z.exactOptional(z.string()),
  greeting: z.exactOptional(z.string()),
}) satisfies Codec<T.SettingsUpdateVoice>;

export const VoiceSaid = z.object({
  agentId: z.string(),
  text: z.string(),
}) satisfies Codec<T.VoiceSaid>;

export const VoiceHeard = z.object({
  agentId: z.string(),
  text: z.string(),
  agent: z.exactOptional(z.string()),
  sendKey: z.exactOptional(z.string()),
}) satisfies Codec<T.VoiceHeard>;

export const VoiceCallStart = z.object({
  channel: z.string(),
  uid: z.string(),
  about: z.exactOptional(z.string()),
}) satisfies Codec<T.VoiceCallStart>;
