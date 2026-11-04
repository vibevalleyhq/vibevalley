// The Schemas of what wants the owner (docs/subsystems/inbox.md): each typed by its shape (Codec<T.X>).

import { Schema } from "effect";

import type { Codec } from "../codec";
import * as T from "../shapes";

export const InboxKind: Codec<T.InboxKind> = Schema.Literals(T.InboxKindValues);

export const InboxFromSession: Codec<T.InboxFromSession> = Schema.Struct({
  kind: Schema.Literal("session"),
  id: Schema.String,
  name: Schema.String,
  agent: Schema.String,
});

export const InboxFromOrchestrator: Codec<T.InboxFromOrchestrator> = Schema.Struct({
  kind: Schema.Literal("orchestrator"),
});

export const InboxFrom: Codec<T.InboxFrom> = Schema.Union([InboxFromSession, InboxFromOrchestrator]);

export const InboxTargetSession: Codec<T.InboxTargetSession> = Schema.Struct({
  kind: Schema.Literal("session"),
  id: Schema.String,
});

export const InboxTargetIssue: Codec<T.InboxTargetIssue> = Schema.Struct({
  kind: Schema.Literal("issue"),
  id: Schema.String,
});

export const InboxTargetChat: Codec<T.InboxTargetChat> = Schema.Struct({
  kind: Schema.Literal("chat"),
  channel: Schema.String,
});

export const InboxTarget: Codec<T.InboxTarget> = Schema.Union([InboxTargetSession, InboxTargetIssue, InboxTargetChat]);

export const InboxWords: Codec<T.InboxWords> = Schema.Struct({
  label: Schema.String,
  title: Schema.String,
  body: Schema.String,
  tray: Schema.String,
});

export const InboxItem: Codec<T.InboxItem> = Schema.Struct({
  id: Schema.String,
  kind: InboxKind,
  from: InboxFrom,
  who: Schema.String,
  text: Schema.String,
  at: Schema.Finite,
  target: InboxTarget,
  words: InboxWords,
});
