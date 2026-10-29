// For the stories only; the product never imports it.

import type { Changes, Issue, IssueAction, IssueAttention, IssueId, IssueStatus, Phase, Priority, Session, SessionId } from "@vibevalley/protocol";

export const now = Date.now();
export const min = 60_000;

const attentionOf: Record<IssueStatus, IssueAttention["state"]> = {
  backlog: "draft",
  todo: "queued",
  in_progress: "working",
  in_review: "reviewing",
  done: "done",
  canceled: "canceled",
};

export const sampleIssue = (number: number, title: string, status: IssueStatus, priority: Priority, more: Partial<Issue> = {}): Issue => ({
  id: `i${number}` as IssueId,
  number,
  title,
  priority,
  status,
  createdAt: now - number * 37 * min,
  sessions: [],
  moves: [],
  deliver: "change",
  findings: [],
  questions: [],
  blockedBy: [],
  criteria: [],
  checks: [],
  attention: { state: attentionOf[status], acts: [] },
  ...more,
});

export const sampleSession = (id: string, agent: string, phase: Phase, more: Partial<Session> = {}): Session => ({
  id: id as SessionId,
  name: agent,
  agent,
  runtime: "claude",
  brief: "",
  hiredAt: now - 42 * min,
  runs: 2,
  phase,
  refining: false,
  ...more,
});

export const working = (since: number, quietSince?: number): Phase => ({
  _tag: "working",
  since,
  doing: { action: "edit_file", label: "改 session.ts" },
  ...(quietSince === undefined ? {} : { quietSince }),
});

// The buttons as the server gives them for each state (apps/server/src/issue/attention.ts): data here, not a rule.
const move = (act: IssueAction["act"], status: IssueStatus, words: "none" | "required" = "none"): IssueAction => ({ act, does: "move", status, words });
export const acts = {
  start: move("start", "todo"),
  close: move("close", "canceled"),
  complete: move("complete", "done"),
  reject: move("reject", "todo", "required"),
  reopen: move("reopen", "todo", "required"),
  cure: move("cure", "todo"),
  resolve: move("resolve", "todo"),
  resume: move("resume", "todo"),
  tell: { act: "tell", does: "say" },
  answer: { act: "answer", does: "say" },
  stop: { act: "stop", does: "stop" },
} satisfies Record<string, IssueAction>;

export const sampleChanges: Changes = {
  project: "vibevalley",
  base: "main",
  branch: "issue-18-login",
  behind: 0,
  conflicts: [],
  uncommitted: [],
  commits: [
    { hash: "a1b2c3d", subject: "Send an expired session back to the sign-in page", at: now - 9 * min },
    { hash: "e4f5a6b", subject: "Test the expiry on both sides of the boundary", at: now - 4 * min },
  ],
  files: [
    {
      path: "apps/web/src/base/session.ts",
      status: "M",
      added: 6,
      removed: 2,
      patch: [
        "@@ -10,7 +10,11 @@ export function session() {",
        "-  if (!s) return undefined;",
        "-  return s;",
        "+  if (!s) return undefined;",
        "+  // Expired: back to sign-in rather than a page that fails on every read.",
        "+  if (expired(s, Date.now())) {",
        "+    location.replace('/signin');",
        "+    return undefined;",
        "+  }",
        "+  return s;",
      ].join("\n"),
    },
    { path: "apps/web/src/base/session.test.ts", status: "A", added: 24, removed: 0 },
    { path: "apps/web/src/base/old-session.ts", status: "D", added: 0, removed: 31 },
  ],
};
