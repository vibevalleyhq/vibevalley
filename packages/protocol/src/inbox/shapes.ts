// The shapes of what wants the owner (docs/subsystems/inbox.md).

export const InboxKindValues = ["review", "ask", "fix", "interrupted", "conflict", "quiet", "mention", "cron-ask"] as const;
export type InboxKind = (typeof InboxKindValues)[number];

/** Told apart by `kind`. */
export type InboxFrom = InboxFromSession | InboxFromOrchestrator;

/** Told apart by `kind`. */
export type InboxTarget = InboxTargetSession | InboxTargetIssue | InboxTargetChat;

/** What an item says on each route the owner hears it on: the phone's label after who, the system notice, the tray's
 * line (none for a mention: it is counted with the unread). */
export interface InboxWords {
  label: string;
  title: string;
  body: string;
  tray: string;
}

export interface InboxItem {
  id: string;
  kind: InboxKind;
  from: InboxFrom;
  /** Who it is from, as the routes say it: the helper's name, or 管家. */
  who: string;
  text: string;
  at: number;
  target: InboxTarget;
  words: InboxWords;
}

export interface InboxFromSession {
  kind: "session";
  id: string;
  name: string;
  agent: string;
}

export interface InboxFromOrchestrator {
  kind: "orchestrator";
}

export interface InboxTargetSession {
  kind: "session";
  id: string;
}

export interface InboxTargetIssue {
  kind: "issue";
  id: string;
}

export interface InboxTargetChat {
  kind: "chat";
  channel: string;
}
