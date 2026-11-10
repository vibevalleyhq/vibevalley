import { Schema } from "effect";

import type { Codec } from "../codec";
import type * as T from "../shapes";
import { UserDevice } from "../user/schema";

export const LanPaired: Codec<T.LanPaired> = Schema.Struct({
  device: Schema.String,
  key: Schema.String,
  hostName: Schema.String,
});

export const LanPairRequest: Codec<T.LanPairRequest> = Schema.Struct({
  code: Schema.String,
  name: Schema.String,
});

export const LanPairing: Codec<T.LanPairing> = Schema.Struct({
  code: Schema.String,
  link: Schema.String,
  expiresAt: Schema.Finite,
  asking: Schema.optionalKey(Schema.String),
});

export const LanStatus: Codec<T.LanStatus> = Schema.Struct({
  open: Schema.Boolean,
  hostName: Schema.String,
  url: Schema.optionalKey(Schema.String),
  problem: Schema.String,
  pairing: Schema.optionalKey(LanPairing),
  devices: Schema.mutable(Schema.Array(UserDevice)),
});

export const SetOpenRequest: Codec<T.SetOpenRequest> = Schema.Struct({
  open: Schema.Boolean,
});

export const AnswerPairingRequest: Codec<T.AnswerPairingRequest> = Schema.Struct({
  allow: Schema.Boolean,
});
