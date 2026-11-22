// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

import type { IssueId, SessionId } from "../common/shapes.gen";

export const InboxKindValues = ["review", "ask", "fix", "interrupted", "conflict", "quiet", "mention", "cron-ask", "budget_reached"] as const;
export type InboxKind = (typeof InboxKindValues)[number];

export type InboxFromSession = { "kind": "session", id: SessionId, name: string, agent: string, };

export type InboxFromOrchestrator = { "kind": "orchestrator", };

export type InboxFromRuntime = { "kind": "runtime", };

/**
 * Told apart by `kind`.
 */
export type InboxFrom = InboxFromSession | InboxFromOrchestrator | InboxFromRuntime;

export type InboxTargetSession = { "kind": "session", id: SessionId, };

export type InboxTargetIssue = { "kind": "issue", id: IssueId, };

export type InboxTargetChat = { "kind": "chat", channel: string, };

export type InboxTargetRuntime = { "kind": "runtime", taskId: string, sessionId?: SessionId, };

/**
 * Told apart by `kind`.
 */
export type InboxTarget = InboxTargetSession | InboxTargetIssue | InboxTargetChat | InboxTargetRuntime;

/**
 * What an item says on each route the user hears it on.
 */
export type InboxWords = { label: string, title: string, body: string, tray: string, };

export type InboxItem = { id: string, kind: InboxKind, from: InboxFrom,
/**
 * Who it is from, as the routes say it: the helper's name, or the orchestrator.
 */
who: string, text: string, at: number, target: InboxTarget, words: InboxWords, };
