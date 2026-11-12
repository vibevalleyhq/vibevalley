import type { GameHandlers } from "@vibevalley/protocol/api";

import type { Game } from "#/modules/game/game.ts";

export function gameHandlers(deps: { readonly game: Game }): GameHandlers {
  const { game } = deps;
  return {
    "game.achievement.list": async () => game.achievements(),
    "game.title.set": (body) => game.chooseTitle(body.achievement, body.tier),
  };
}
