import { type Endpoint } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface CoreHandlers {
  readonly "server.health.get": () => Promise<T.Health>;
}

export const coreEndpoints: readonly Endpoint[] = [
  {
    op: "server.health.get",
    about: [],
    input: undefined,
    result: S.Health,
    can: ["user", "remote"],
  },
];
