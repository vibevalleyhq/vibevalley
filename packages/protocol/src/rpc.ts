// What a page subscribes to over its one WebSocket (rpcPath): the server implements Subscriptions
// (apps/server/src/http/rpc.ts), the page calls it (apps/web/src/base/gateway.ts). Writes stay on the HTTP endpoints (api.ts).

import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { ApiError } from "./api";
import * as S from "./schema";

export const rpcPath = "/api/v1/rpc";

export class Subscriptions extends RpcGroup.make(
  /** What changed in a channel after the revision after, then each change from now on, each the message as it now is. */
  Rpc.make("channel.follow", { payload: { id: Schema.String, after: Schema.Finite }, success: S.ChannelEvent, error: ApiError, stream: true }),
  /** The turn reports in any channel after the one with this id (by message id, which sorts by time), or the newest
   * when absent, then each report from now on. */
  Rpc.make("channel.reports", { payload: { after: Schema.optionalKey(Schema.String) }, success: S.ChannelEvent, error: ApiError, stream: true }),
) {}
