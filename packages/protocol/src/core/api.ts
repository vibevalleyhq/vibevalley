import { type Effect } from "effect";

import { type ApiError, type Endpoint } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface CoreHandlers<R = never> {
  readonly "server.health.get": () => Effect.Effect<T.Health, ApiError, R>;
}

export const coreEndpoints: readonly Endpoint[] = [
  {
    op: "server.health.get",
    about: [],
    input: undefined,
    result: S.Health,
    can: ["owner", "remote"],
  },
];
