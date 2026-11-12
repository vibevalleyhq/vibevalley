import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface ConnectorHandlers {
  readonly "connector.list": () => Promise<T.ConnectorStatus[]>;
  readonly "connector.login": (a: { readonly id: T.ConnectorID } & T.ConnectorLogin) => Promise<T.ConnectorStatus>;
  readonly "connector.verify": (a: { readonly id: T.ConnectorID } & T.VerifyRequest) => Promise<T.ConnectorStatus>;
  readonly "connector.logout": (a: { readonly id: T.ConnectorID }) => Promise<T.ConnectorStatus>;
  readonly "connector.channel.set": (a: { readonly id: T.ConnectorID } & T.ConnectorsChannelRequest) => Promise<T.ConnectorStatus>;
}

export const connectorEndpoints: readonly Endpoint[] = [
  {
    op: "connector.list",
    about: [],
    input: undefined,
    result: z.array(S.ConnectorStatus),
    can: ["user", "remote"],
  },
  {
    op: "connector.login",
    about: ["id"],
    input: input({ id: z.string() }, S.ConnectorLogin),
    result: S.ConnectorStatus,
    can: ["user"],
  },
  {
    op: "connector.verify",
    about: ["id"],
    input: input({ id: z.string() }, S.VerifyRequest),
    result: S.ConnectorStatus,
    can: ["user"],
  },
  {
    op: "connector.logout",
    about: ["id"],
    input: input({ id: z.string() }),
    result: S.ConnectorStatus,
    can: ["user"],
  },
  {
    op: "connector.channel.set",
    about: ["id"],
    input: input({ id: z.string() }, S.ConnectorsChannelRequest),
    result: S.ConnectorStatus,
    can: ["user"],
  },
];
