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
  /** Opens or resumes a direct workspace chat session in a directory with no issue. */
  readonly "session.openWorkspace": (a: T.SessionOpenWorkspaceInput) => Promise<T.SessionWorkspace>;
  /** Starts a turn when idle; steers the current turn when working. */
  readonly "session.send": (a: T.SessionSendInput) => Promise<T.Session>;
  readonly "session.respondPermission": (a: T.SessionRespondPermissionInput) => Promise<void>;
  readonly "session.respondInteraction": (a: T.SessionRespondInteractionInput) => Promise<void>;
  readonly "session.setConfig": (a: T.SessionSetConfigInput) => Promise<T.SessionWorkspace>;
  readonly "session.childTranscript": (a: T.SessionChildTranscriptInput) => Promise<T.SessionChildTranscript>;
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
  {
    op: "session.openWorkspace",
    about: [],
    input: input({
      sessionId: z.exactOptional(z.string()),
      runtime: z.string(),
      cwd: z.string(),
      repo: z.exactOptional(z.string()),
      model: z.exactOptional(z.string()),
      effort: z.exactOptional(z.string()),
      permissionMode: z.exactOptional(S.SessionPermissionMode),
      title: z.exactOptional(z.string()),
    }),
    result: S.SessionWorkspace,
    can: ["user", "remote"],
  },
  {
    op: "session.send",
    about: ["id"],
    input: input({
      id: z.string(),
      text: z.string(),
      attachments: z.exactOptional(z.array(z.string())),
      contextFiles: z.exactOptional(z.array(S.SessionContextFile)),
    }),
    result: S.Session,
    can: ["user", "remote"],
  },
  {
    op: "session.respondPermission",
    about: ["id"],
    input: input({
      id: z.string(),
      requestId: z.string(),
      decision: S.SessionPermissionDecision,
      message: z.exactOptional(z.string()),
    }),
    result: undefined,
    can: ["user", "remote"],
  },
  {
    op: "session.respondInteraction",
    about: ["id"],
    input: input({
      id: z.string(),
      requestId: z.string(),
      optionId: z.exactOptional(z.string()),
      text: z.exactOptional(z.string()),
      cancelled: z.exactOptional(z.boolean()),
    }),
    result: undefined,
    can: ["user", "remote"],
  },
  {
    op: "session.setConfig",
    about: ["id"],
    input: input({
      id: z.string(),
      model: z.exactOptional(z.string()),
      effort: z.exactOptional(z.string()),
      permissionMode: z.exactOptional(S.SessionPermissionMode),
    }),
    result: S.SessionWorkspace,
    can: ["user", "remote"],
  },
  {
    op: "session.childTranscript",
    about: ["id"],
    input: input({
      id: z.string(),
      conversationId: z.string(),
      limit: z.exactOptional(z.number()),
    }),
    result: S.SessionChildTranscript,
    can: ["user", "remote"],
  },
];
