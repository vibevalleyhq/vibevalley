import { type Endpoint } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface RemoteHandlers {
  readonly "remote.status": () => Promise<T.RemoteStatus>;
  readonly "remote.enable": (a: T.RemoteEnableRequest) => Promise<T.RemoteStatus>;
  readonly "remote.disable": () => Promise<T.RemoteStatus>;
  readonly "remote.pair.create": () => Promise<T.RemotePairCode>;
  readonly "remote.pair.exchange": (a: T.RemotePairExchangeRequest) => Promise<T.RemotePairExchangeResult>;
  readonly "remote.device.revoke": (a: T.RemoteDeviceRevokeRequest) => Promise<void>;
  readonly "remote.whoami": () => Promise<T.RemoteWhoami>;
}

export const remoteEndpoints: readonly Endpoint[] = [
  {
    op: "remote.status",
    about: [],
    input: undefined,
    result: S.RemoteStatus,
    can: ["user"],
  },
  {
    op: "remote.enable",
    about: [],
    input: S.RemoteEnableRequest,
    result: S.RemoteStatus,
    can: ["user"],
  },
  {
    op: "remote.disable",
    about: [],
    input: undefined,
    result: S.RemoteStatus,
    can: ["user"],
  },
  {
    op: "remote.pair.create",
    about: [],
    input: undefined,
    result: S.RemotePairCode,
    can: ["user"],
  },
  {
    op: "remote.pair.exchange",
    about: [],
    input: S.RemotePairExchangeRequest,
    result: S.RemotePairExchangeResult,
    can: ["user", "remote"],
  },
  {
    op: "remote.device.revoke",
    about: ["id"],
    input: S.RemoteDeviceRevokeRequest,
    result: undefined,
    can: ["user"],
  },
  {
    op: "remote.whoami",
    about: [],
    input: undefined,
    result: S.RemoteWhoami,
    can: ["user", "remote"],
  },
];
