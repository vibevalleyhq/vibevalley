import { Effect } from "effect";

import type { GameHandlers } from "@vibevalley/protocol/api";

import { Game } from "#/modules/game/game.ts";

export const gameHandlers = Effect.gen(function* () {
  const game = yield* Game;
  const done: GameHandlers = {
    "game.achievement.list": () => Effect.sync(game.achievements),
    "game.title.set": (body) => game.chooseTitle(body.achievement, body.tier),
  };
  return done;
});
