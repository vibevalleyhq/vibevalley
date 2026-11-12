import type { Endpoint } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface LanHandlers {
  readonly "lan.get": () => Promise<T.LanStatus>;
  readonly "lan.update": (a: T.SetOpenRequest) => Promise<T.LanStatus>;
  readonly "lan.pairing.start": () => Promise<T.LanStatus>;
  readonly "lan.pairing.stop": () => Promise<T.LanStatus>;
  /** What stopPairing would do, refused as it would be; nothing changes. */
  readonly "lan.pairing.previewStop": () => Promise<T.Preview>;
  readonly "lan.pairing.answer": (a: T.AnswerPairingRequest) => Promise<T.LanStatus>;
  readonly "lan.pair": (a: T.LanPairRequest) => Promise<T.LanPaired>;
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
    op: "lan.pair",
    about: [],
    input: S.LanPairRequest,
    result: S.LanPaired,
    can: ["user", "remote"],
  },
];
