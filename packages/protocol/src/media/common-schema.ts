import { z } from "zod";

import type { Codec } from "../codec";
import * as T from "./shapes";

export const MediaPhase = z.enum(T.MediaPhaseValues) satisfies Codec<T.MediaPhase>;
export const MediaSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("orchestrator"), agent: z.string().min(1), channel: z.string() }),
]) satisfies Codec<T.MediaSource>;
export const MediaInputReference = z.object({
  id: z.string().min(1),
  kind: z.enum(T.MediaInputKindValues),
  name: z.string(),
  mime: z.string(),
  size: z.number().int(),
  hash: z.string().regex(/^[0-9a-f]{64}$/u),
}) satisfies Codec<T.MediaInputReference>;
export const MediaAudioMetadata = z.object({
  source: z.enum(T.MediaAudioMetadataSourceValues),
  sampleRate: z.exactOptional(z.number().gt(0)),
  duration: z.exactOptional(z.number().gt(0)),
  channels: z.exactOptional(z.number().int().gt(0)),
  bitDepth: z.exactOptional(z.number().int().gt(0)),
}) satisfies Codec<T.MediaAudioMetadata>;
export const MediaAudioUsage = z.object({
  inputCharacters: z.exactOptional(z.number().int().min(0)),
  promptTokens: z.exactOptional(z.number().int().min(0)),
  completionTokens: z.exactOptional(z.number().int().min(0)),
  totalTokens: z.exactOptional(z.number().int().min(0)),
  inputAudioSeconds: z.exactOptional(z.number().min(0)),
}) satisfies Codec<T.MediaAudioUsage>;
