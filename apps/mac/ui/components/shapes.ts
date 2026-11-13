// The serde JSON shapes the views render, mirrored from Rust:
// `vibevalley_core` (crates/vibevalley-core/src/model.rs, core.rs, inbox.rs) and
// `vibevalley_oar::Event` (crates/vibevalley-oar/src/lib.rs). Types only: the
// views never compute business state, they read it from these.

export type Millis = number;

// ---- vibevalley_core ----

export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "canceled";
export type Priority = "urgent" | "high" | "medium" | "low";
export type Deliverable = "change" | "branch" | "answer" | "pull_request";
export type Landing = "merged" | "merged_into_parent" | "pull_request" | "submitted" | "kept" | "none";
export type Outcome = "completed" | "failed" | "interrupted";
export type StageKind = "draft" | "queued" | "working" | "asking" | "reviewing" | "stuck" | "done" | "canceled";
export type StuckReason = "failed" | "conflict" | "interrupted" | "quiet";
export type Act = "start" | "answer" | "reject" | "complete" | "acknowledge" | "resolve" | "resume" | "cure" | "tell" | "stop" | "close" | "reopen";
export type Words = "none" | "optional" | "required";

/** A button of an issue: what it is called and what pressing it sends. */
export type Action = { does: "move"; act: Act; status: IssueStatus; words: Words } | { does: "say"; act: Act } | { does: "stop"; act: Act };

export type Stage = {
  state: StageKind;
  since: Millis | null;
  stuck: StuckReason | null;
  lead: Act | null;
  acts: Action[];
};

export type Execution = { session: string; started_at: Millis; in_process: boolean };
export type Assignment = { id: string; agent: string; assigned_at: Millis; ended_at: Millis | null; executions: Execution[] };
export type Question = { question: string; options: string[] };
export type IssueAnswer = { conclusion: string; evidence: string[] };

export type Issue = {
  id: string;
  number: number;
  title: string;
  description: string;
  repo: string | null;
  assignments: Assignment[];
  priority: Priority;
  rank: number | null;
  created_at: Millis;
  queued_at: Millis | null;
  closed_at: Millis | null;
  delivered: Landing | null;
  canceled: "dismissed" | "lost" | null;
  parent: string | null;
  blocked_by: string[];
  conflict: { base: string; files: string[] } | null;
  deliver: Deliverable;
  reviewed_at: Millis | null;
  questions: Question[];
  criteria: string[];
  refining: { session: string; name: string } | null;
  last_run: { started_at: Millis; ended_at: Millis | null; outcome: Outcome | null } | null;
  answer: IssueAnswer | null;
  pull_request?: { url: string; number: number; state: "open" | "merged" | "closed" } | null;
  status: IssueStatus;
  moves: IssueStatus[];
  stage: Stage;
};

export type Phase = { tag: "working"; since: Millis; doing: string; quiet_since: Millis | null } | { tag: "done" } | { tag: "failed" } | { tag: "resting" };

export type Session = {
  id: string;
  role: "worker" | "orchestrator";
  name: string;
  agent: string;
  runtime: string;
  brief: string;
  repo: string | null;
  branch: string | null;
  worktree: string | null;
  hired_at: Millis;
  runs: number;
  phase: Phase;
  last_run: { outcome: Outcome; summary: string; at: Millis; answer: IssueAnswer | null } | null;
  issue: string | null;
  refining: boolean;
};

export type InboxKind = "review" | "ask" | "fix" | "interrupted" | "conflict" | "quiet";

export type InboxItem = {
  id: string;
  kind: InboxKind;
  who: string | null;
  issue: string | null;
  text: string;
  at: Millis;
  target: { kind: "session"; id: string } | { kind: "issue"; id: string };
};

export type Frame = { seq: number; issues: Issue[]; sessions: Session[]; inbox: InboxItem[] };

/**
 * What an issue view emits: the frame's own action object plus the issue
 * id, and the user's words when the action takes them.
 */
export type IssueIntent = { issue: string; act: Act; does: Action["does"]; status?: IssueStatus; words?: string };

export function intentOf(issue: string, action: Action, words?: string): IssueIntent {
  const base: IssueIntent = { issue, act: action.act, does: action.does };
  if (action.does === "move") base.status = action.status;
  if (words !== undefined && words !== "") base.words = words;
  return base;
}

// ---- vibevalley_oar ----

export type PermissionDecision = "AllowOnce" | "AllowAlways" | { Deny: { message: string | null } };

export type EventKind =
  | { type: "session_started"; session_id: string; model: string | null }
  | { type: "turn_started"; prompt: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_started"; id: string; name: string; input: unknown }
  | { type: "tool_call_finished"; id: string; ok: boolean; output: string }
  | { type: "file_changed"; path: string; change: "Created" | "Modified" | "Deleted" }
  | { type: "permission_requested"; request_id: string; tool: string; input: unknown; summary: string }
  | { type: "permission_resolved"; request_id: string; decision: PermissionDecision }
  | { type: "question"; text: string }
  | {
      type: "turn_finished";
      reason: "Completed" | "Aborted" | "MaxTurns" | "Error";
      usage: { input_tokens: number | null; output_tokens: number | null; cost_usd: number | null };
    }
  | { type: "error"; message: string }
  | { type: "session_ended" };

export type AgentEvent = { seq: number; agent_path: string[]; at_ms: Millis; kind: EventKind };

/** What a permission answer sends back (`Session::respond_permission`). */
export type PermissionIntent = { session?: string; request_id: string; decision: PermissionDecision };
