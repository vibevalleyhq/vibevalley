// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

import type { IssueId, SessionId } from "../common/shapes.gen";

export const InboxKindValues = ["review", "ask", "fix", "interrupted", "conflict", "quiet", "mention", "cron-ask"] as const;
export type InboxKind = (typeof InboxKindValues)[number];

export type InboxFromSession = { "kind": "session", id: SessionId, name: string, agent: string, };

export type InboxFromOrchestrator = { "kind": "orchestrator", };

/**
 * Told apart by `kind`.
 */
export type InboxFrom = InboxFromSession | InboxFromOrchestrator;

export type InboxTargetSession = { "kind": "session", id: SessionId, };

export type InboxTargetIssue = { "kind": "issue", id: IssueId, };

export type InboxTargetChat = { "kind": "chat", channel: string, };

/**
 * Told apart by `kind`.
 */
export type InboxTarget = InboxTargetSession | InboxTargetIssue | InboxTargetChat;

/**
 * What an item says on each route the user hears it on.
 */
export type InboxWords = { label: string, title: string, body: string, tray: string, };

export type InboxItem = { id: string, kind: InboxKind, from: InboxFrom, 
/**
 * Who it is from, as the routes say it: the helper's name, or the orchestrator.
 */
who: string, text: string, at: number, target: InboxTarget, words: InboxWords, };
