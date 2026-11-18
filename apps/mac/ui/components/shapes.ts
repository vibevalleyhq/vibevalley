// The serde JSON shapes the component gallery renders, mirrored from
// `vibevalley_oar::Event` (crates/vibevalley-oar/src/lib.rs).

type Millis = number;

type PermissionDecision = "AllowOnce" | "AllowAlways" | { Deny: { message: string | null } };

type EventKind =
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
