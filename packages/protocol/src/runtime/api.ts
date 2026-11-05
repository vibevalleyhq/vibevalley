import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface RuntimeHandlers<R = never> {
  readonly "runtime.list": () => Effect.Effect<T.RuntimeInfo[], ApiError, R>;
  readonly "runtime.refresh": (a: { readonly id: string }) => Effect.Effect<T.RuntimeInfo, ApiError, R>;
  readonly "runtime.setting.update": (a: { readonly id: string } & T.RuntimeSettings) => Effect.Effect<T.RuntimeInfo, ApiError, R>;
}

export const runtimeEndpoints: readonly Endpoint[] = [
  {
    op: "runtime.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.RuntimeInfo)),
    can: ["owner", "remote"],
  },
  {
    op: "runtime.refresh",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.RuntimeInfo,
    can: ["owner", "remote"],
  },
  {
    op: "runtime.setting.update",
    about: ["id"],
    input: input({ id: Schema.String }, S.RuntimeSettings),
    result: S.RuntimeInfo,
    can: ["owner"],
  },
];
