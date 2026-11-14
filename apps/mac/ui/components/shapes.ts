// The serde JSON shapes the views render, mirrored from Rust:
// `vibevalley_core` (crates/vibevalley-core/src/model.rs, core.rs, inbox.rs) and
// `vibevalley_oar::Event` (crates/vibevalley-oar/src/lib.rs). Types only: the
// views never compute business state, they read it from these.

export type Millis = number;

// ---- vibevalley_core ----

export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "canceled";

export type Act = "start" | "answer" | "reject" | "complete" | "acknowledge" | "resolve" | "resume" | "cure" | "tell" | "stop" | "close" | "reopen";
export type Words = "none" | "optional" | "required";

/** A button of an issue: what it is called and what pressing it sends. */
export type Action = { does: "move"; act: Act; status: IssueStatus; words: Words } | { does: "say"; act: Act } | { does: "stop"; act: Act };

export type InboxKind = "review" | "ask" | "fix" | "interrupted" | "conflict" | "quiet";

/**
 * What an issue view emits: the frame's own action object plus the issue
 * id, and the user's words when the action takes them.
 */
export type IssueIntent = { issue: string; act: Act; does: Action["does"]; status?: IssueStatus; words?: string };

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
