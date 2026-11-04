// The endpoints of the game: their answers (GameHandlers) and their lines in the table (api.ts puts the
// concepts together).

import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface GameHandlers<R = never> {
  /** Every achievement, as the board has them. */
  readonly "game.achievement.list": () => Effect.Effect<T.Achievement[], ApiError, R>;
  readonly "game.title.set": (a: T.ChooseTitleRequest) => Effect.Effect<void, ApiError, R>;
}

export const gameEndpoints: readonly Endpoint[] = [
  {
    op: "game.achievement.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.Achievement)),
    can: ["owner", "remote"],
  },
  {
    op: "game.title.set",
    about: [],
    input: S.ChooseTitleRequest,
    result: undefined,
    can: ["owner", "remote"],
  },
];
