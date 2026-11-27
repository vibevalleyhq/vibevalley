import { type Endpoint } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface GameHandlers {
  readonly "game.shop.list": () => Promise<T.FarmShopView>;
  readonly "game.shop.buy": (a: T.ShopPurchaseRequest) => Promise<T.FarmShopView>;
}

export const gameEndpoints: readonly Endpoint[] = [
  {
    op: "game.shop.list",
    about: [],
    input: undefined,
    result: S.FarmShopView,
    can: ["user", "remote"],
  },
  {
    op: "game.shop.buy",
    about: ["id"],
    input: S.ShopPurchaseRequest,
    result: S.FarmShopView,
    can: ["user", "remote"],
  },
];
