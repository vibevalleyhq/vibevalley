// The answers of the game endpoints (packages/protocol/src/game/api.ts): each forwards to the service that owns the rule.

import { Effect } from "effect";

import type { GameHandlers } from "@vibevalley/protocol/api";

import { Game } from "@/game/game.ts";

export const gameHandlers = Effect.gen(function* () {
  const game = yield* Game;
  const done: GameHandlers = {
    "game.achievement.list": () => Effect.sync(game.achievements),
    "game.title.set": (body) => game.chooseTitle(body.achievement, body.tier),
  };
  return done;
});
