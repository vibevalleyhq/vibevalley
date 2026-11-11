import { z } from "zod";

import type { Codec } from "../codec";
import type * as T from "./shapes";

export const LanPaired = z.object({
  device: z.string(),
  key: z.string(),
  hostName: z.string(),
}) satisfies Codec<T.LanPaired>;

export const LanPairRequest = z.object({
  code: z.string(),
  name: z.string(),
}) satisfies Codec<T.LanPairRequest>;

const LanPairing = z.object({
  code: z.string(),
  link: z.string(),
  expiresAt: z.number(),
  asking: z.exactOptional(z.string()),
}) satisfies Codec<T.LanPairing>;

export const LanStatus = z.object({
  open: z.boolean(),
  hostName: z.string(),
  url: z.exactOptional(z.string()),
  problem: z.string(),
  pairing: z.exactOptional(LanPairing),
}) satisfies Codec<T.LanStatus>;

export const SetOpenRequest = z.object({
  open: z.boolean(),
}) satisfies Codec<T.SetOpenRequest>;

export const AnswerPairingRequest = z.object({
  allow: z.boolean(),
}) satisfies Codec<T.AnswerPairingRequest>;
