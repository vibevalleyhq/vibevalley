// What a page subscribes to over one WebSocket (/api/v1/rooms): the server implements Rooms (apps/server/src/http/rooms.ts),
// the page calls it (apps/web/src/data/gateway.ts). Writes stay on the HTTP endpoints (api.ts).

import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { ApiError } from "./api";
import * as S from "./schema";

export const roomsPath = "/api/v1/rooms";

export class Rooms extends RpcGroup.make(
  /** What is said in a conversation after the message numbered after, then what is said there from now on. */
  Rpc.make("rooms.follow", { payload: { room: Schema.String, after: Schema.Number }, success: S.RoomEvent, error: ApiError, stream: true }),
) {}
