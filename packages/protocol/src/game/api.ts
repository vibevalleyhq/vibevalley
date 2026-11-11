import { z } from "zod";

import { type Endpoint } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface GameHandlers {
  /** Every achievement, as the board has them. */
  readonly "game.achievement.list": () => Promise<T.Achievement[]>;
  readonly "game.title.set": (a: T.ChooseTitleRequest) => Promise<void>;
}

export const gameEndpoints: readonly Endpoint[] = [
  {
    op: "game.achievement.list",
    about: [],
    input: undefined,
    result: z.array(S.Achievement),
    can: ["user", "remote"],
  },
  {
    op: "game.title.set",
    about: [],
    input: S.ChooseTitleRequest,
    result: undefined,
    can: ["user", "remote"],
  },
];
