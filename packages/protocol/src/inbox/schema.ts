import { z } from "zod";

import type { Codec } from "../codec";
import { IssueId, SessionId } from "../common/schema";
import * as T from "./shapes";

const InboxKind = z.enum(T.InboxKindValues) satisfies Codec<T.InboxKind>;

const InboxFromSession = z.object({
  kind: z.literal("session"),
  id: SessionId,
  name: z.string(),
  agent: z.string(),
}) satisfies Codec<T.InboxFromSession>;

const InboxFromOrchestrator = z.object({
  kind: z.literal("orchestrator"),
}) satisfies Codec<T.InboxFromOrchestrator>;

const InboxFrom = z.discriminatedUnion("kind", [InboxFromSession, InboxFromOrchestrator]) satisfies Codec<T.InboxFrom>;

const InboxTargetSession = z.object({
  kind: z.literal("session"),
  id: SessionId,
}) satisfies Codec<T.InboxTargetSession>;

const InboxTargetIssue = z.object({
  kind: z.literal("issue"),
  id: IssueId,
}) satisfies Codec<T.InboxTargetIssue>;

const InboxTargetChat = z.object({
  kind: z.literal("chat"),
  channel: z.string(),
}) satisfies Codec<T.InboxTargetChat>;

const InboxTarget = z.discriminatedUnion("kind", [InboxTargetSession, InboxTargetIssue, InboxTargetChat]) satisfies Codec<T.InboxTarget>;

const InboxWords = z.object({
  label: z.string(),
  title: z.string(),
  body: z.string(),
  tray: z.string(),
}) satisfies Codec<T.InboxWords>;

export const InboxItem = z.object({
  id: z.string(),
  kind: InboxKind,
  from: InboxFrom,
  who: z.string(),
  text: z.string(),
  at: z.number(),
  target: InboxTarget,
  words: InboxWords,
}) satisfies Codec<T.InboxItem>;
