import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const cronDeleteInput = input({ id: z.string() });

export interface CronHandlers {
  readonly "cron.create": (a: T.CronRequest) => Promise<T.Cron>;
  readonly "cron.list": () => Promise<T.Cron[]>;
  /** Only what the body gives changes. */
  readonly "cron.update": (a: { readonly id: string } & T.CronUpdate) => Promise<void>;
  readonly "cron.delete": (a: { readonly id: string }) => Promise<void>;
  /** What delete would do, refused as it would be; nothing changes. */
  readonly "cron.previewDelete": (a: { readonly id: string }) => Promise<T.Preview>;
}

export const cronEndpoints: readonly Endpoint[] = [
  {
    op: "cron.create",
    about: [],
    input: S.CronRequest,
    result: S.Cron,
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "cron.list",
    about: [],
    input: undefined,
    result: z.array(S.Cron),
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "cron.update",
    about: ["id"],
    input: input({ id: z.string() }, S.CronUpdate),
    result: undefined,
    can: ["user", "remote"],
  },
  {
    op: "cron.delete",
    about: ["id"],
    input: cronDeleteInput,
    result: undefined,
    can: ["user", "remote", "orchestrator"],
    dryRun: "cron.previewDelete",
  },
  {
    op: "cron.previewDelete",
    about: ["id"],
    input: cronDeleteInput,
    result: S.Preview,
    can: ["user", "remote", "orchestrator"],
  },
];
