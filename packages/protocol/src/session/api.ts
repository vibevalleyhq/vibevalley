import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface SessionHandlers {
  /** Stops a session's turn; it stays, and a comment starts the next. */
  readonly "session.stop": (a: { readonly id: string }) => Promise<void>;
  readonly "session.list": (a: { readonly agent?: string }) => Promise<T.Session[]>;
  readonly "session.get": (a: { readonly id: string }) => Promise<T.Session>;
  /** Its log, oldest first. run gives one run's only. */
  readonly "session.event.list": (a: { readonly id: string; readonly run?: string }) => Promise<T.SessionEvent[]>;
}

export const sessionEndpoints: readonly Endpoint[] = [
  {
    op: "session.stop",
    about: ["id"],
    input: input({ id: z.string() }),
    result: undefined,
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "session.list",
    about: [],
    input: input({ agent: z.exactOptional(z.string()) }),
    result: z.array(S.Session),
    can: ["user", "remote", "orchestrator", "session"],
  },
  {
    op: "session.get",
    about: ["id"],
    input: input({ id: z.string() }),
    result: S.Session,
    can: ["user", "remote"],
  },
  {
    op: "session.event.list",
    about: ["id"],
    input: input({ id: z.string(), run: z.exactOptional(z.string()) }),
    result: z.array(S.SessionEvent),
    can: ["user", "remote"],
  },
];
