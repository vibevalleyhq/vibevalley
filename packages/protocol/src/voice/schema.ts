import { z } from "zod";

import type { Codec } from "../codec";
import * as T from "./shapes";

export const CallState = z.enum(T.CallStateValues) satisfies Codec<T.CallState>;

export const VoiceSettings = z.object({
  persona: z.string(),
  greeting: z.string(),
}) satisfies Codec<T.VoiceSettings>;

export const SettingsUpdateVoice = z.object({
  persona: z.exactOptional(z.string()),
  greeting: z.exactOptional(z.string()),
}) satisfies Codec<T.SettingsUpdateVoice>;
