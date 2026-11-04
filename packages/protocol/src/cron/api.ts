// The endpoints of crons: their answers (CronHandlers) and their lines in the table (api.ts puts the
// concepts together).

import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const cronDeleteInput = input({ id: Schema.String });

export interface CronHandlers<R = never> {
  readonly "cron.create": (a: T.CronRequest) => Effect.Effect<T.Cron, ApiError, R>;
  readonly "cron.list": () => Effect.Effect<T.Cron[], ApiError, R>;
  /** Only what the body gives changes. */
  readonly "cron.update": (a: { readonly id: string } & T.CronUpdate) => Effect.Effect<void, ApiError, R>;
  readonly "cron.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** What delete would do, refused as it would be; nothing changes. */
  readonly "cron.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
}

export const cronEndpoints: readonly Endpoint[] = [
  {
    op: "cron.create",
    about: [],
    input: S.CronRequest,
    result: S.Cron,
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "cron.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.Cron)),
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "cron.update",
    about: ["id"],
    input: input({ id: Schema.String }, S.CronUpdate),
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "cron.delete",
    about: ["id"],
    input: cronDeleteInput,
    result: undefined,
    can: ["owner", "remote", "orchestrator"],
    dryRun: "cron.previewDelete",
  },
  {
    op: "cron.previewDelete",
    about: ["id"],
    input: cronDeleteInput,
    result: S.Preview,
    can: ["owner", "remote", "orchestrator"],
  },
];
