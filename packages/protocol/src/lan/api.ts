import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const lanDeviceDeleteInput = input({ id: Schema.String });

export interface LanHandlers<R = never> {
  readonly "lan.get": () => Effect.Effect<T.LanStatus, ApiError, R>;
  readonly "lan.update": (a: T.SetOpenRequest) => Effect.Effect<T.LanStatus, ApiError, R>;
  readonly "lan.pairing.start": () => Effect.Effect<T.LanStatus, ApiError, R>;
  readonly "lan.pairing.stop": () => Effect.Effect<T.LanStatus, ApiError, R>;
  /** What stopPairing would do, refused as it would be; nothing changes. */
  readonly "lan.pairing.previewStop": () => Effect.Effect<T.Preview, ApiError, R>;
  readonly "lan.pairing.answer": (a: T.AnswerPairingRequest) => Effect.Effect<T.LanStatus, ApiError, R>;
  readonly "lan.device.delete": (a: { readonly id: string }) => Effect.Effect<T.LanStatus, ApiError, R>;
  /** What deleteDevice would do, refused as it would be; nothing changes. */
  readonly "lan.device.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
  readonly "lan.pair": (a: T.LanPairRequest) => Effect.Effect<T.LanPaired, ApiError, R>;
  readonly "lan.me.get": () => Effect.Effect<T.UserDevice, ApiError, R>;
}

export const lanEndpoints: readonly Endpoint[] = [
  {
    op: "lan.get",
    about: [],
    input: undefined,
    result: S.LanStatus,
    can: ["user"],
  },
  {
    op: "lan.update",
    about: [],
    input: S.SetOpenRequest,
    result: S.LanStatus,
    can: ["user"],
  },
  {
    op: "lan.pairing.start",
    about: [],
    input: undefined,
    result: S.LanStatus,
    can: ["user"],
  },
  {
    op: "lan.pairing.stop",
    about: [],
    input: undefined,
    result: S.LanStatus,
    can: ["user"],
    dryRun: "lan.pairing.previewStop",
  },
  {
    op: "lan.pairing.previewStop",
    about: [],
    input: undefined,
    result: S.Preview,
    can: ["user"],
  },
  {
    op: "lan.pairing.answer",
    about: [],
    input: S.AnswerPairingRequest,
    result: S.LanStatus,
    can: ["user"],
  },
  {
    op: "lan.device.delete",
    about: ["id"],
    input: lanDeviceDeleteInput,
    result: S.LanStatus,
    can: ["user"],
    dryRun: "lan.device.previewDelete",
  },
  {
    op: "lan.device.previewDelete",
    about: ["id"],
    input: lanDeviceDeleteInput,
    result: S.Preview,
    can: ["user"],
  },
  {
    op: "lan.pair",
    about: [],
    input: S.LanPairRequest,
    result: S.LanPaired,
    can: ["user", "remote"],
  },
  {
    op: "lan.me.get",
    about: [],
    input: undefined,
    result: S.UserDevice,
    can: ["user", "remote"],
  },
];
