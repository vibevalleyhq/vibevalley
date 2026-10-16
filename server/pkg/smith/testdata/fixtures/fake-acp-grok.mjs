/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, eslint/no-underscore-dangle -- Standalone untyped fixture module for fake-acp-agent.mjs. */
// grok 1.0.25 (f7e67d6988e2) frames as tapped live on 2026-09-11
// (experiments/grok-wire-tap.ts → oar-trial-run/live-grok-tap/wire.jsonl;
// oar-trial-run/live-grok-c/subagent.voyage.jsonl seqs 52-121;
// live-grok-a/basic.voyage.jsonl seq 49), ids shortened.

const CHILD = "fake-child-grok";
const LINEAGE = { parent_session_id: "fake-session", child_session_id: CHILD, subagent_type: "general-purpose" };

// servers_updated's env shape from Grok 1.0.46 (oar#182), with dummy values.
// Headers and bearer_token exercise the same rule if Grok exposes them.
export function grokMcpCredentials(send, phase, mode) {
  if (mode !== "grok-credentials") {
    return;
  }
  send({ jsonrpc: "2.0", method: "_x.ai/mcp/servers_updated", params: {
    phase,
    mcpServers: [
      { name: "local", source: "local", type: "stdio", command: "echo", args: [], env: [{ name: "API_KEY", value: "fixture-env-secret" }] },
      { name: "remote", type: "http", url: "https://example.test/mcp", headers: [{ name: "Authorization", value: "fixture-header-secret" }], bearer_token: "fixture-bearer-secret" },
    ],
  } });
}

/**
 * One sub-agent run: the vendor `_x.ai/session_notification` twin of
 * session/update carries the lineage snake_case under `update`;
 * `subagent_finished` names only the child, the parent being the envelope's
 * session. The child's own standard updates arrive under its own session id
 * in between. `send`/`update` are the agent's framing helpers.
 */
export function spawnChildGrok(send, update) {
  const vendor = (value, sessionId = "fake-session") => send({ jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId, update: value } });
  vendor({ sessionUpdate: "subagent_spawned", subagent_id: CHILD, ...LINEAGE, description: "Echo", model: "fixture-model-x" });
  update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "child-task" } }, CHILD);
  vendor({ sessionUpdate: "subagent_progress", subagent_id: CHILD, ...LINEAGE, turn_count: 1, tokens_used: 10 });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child-says-hi" } }, CHILD);
  // The child's own model-call and turn ledgers ride the vendor method with
  // the CHILD's id in the envelope (live seqs 78, 119, 120).
  vendor({ sessionUpdate: "response_completed", usage: { input_tokens: 80, output_tokens: 8, cache_read_input_tokens: 0 } }, CHILD);
  vendor({ sessionUpdate: "turn_completed", prompt_id: "child-prompt", stop_reason: "end_turn", usage: { inputTokens: 80, outputTokens: 8, totalTokens: 88, modelCalls: 1 } }, CHILD);
  vendor({ sessionUpdate: "subagent_finished", subagent_id: CHILD, child_session_id: CHILD, status: "completed", output: "child-says-hi", will_wake: false });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "parent-continues" } });
  // The parent's ledger already sums the child's calls (live seq 159 = 48+78+119+155).
  return { stopReason: "end_turn", _meta: { totalTokens: 300, usage: { inputTokens: 200, outputTokens: 20, modelCalls: 2 } } };
}

let ledgers = 0;

/**
 * A grok prompt answer: `_meta.totalTokens` is the context count (grows by
 * one per answer here), `_meta.usage` THIS prompt's own ledger (turn 1 and
 * turn 2 bill alike, not a running sum), with the cache fields of the live
 * basic answer (`cachedReadTokens`, `cacheCreationTokens`). Streams one text
 * chunk first.
 */
export function grokUsageAnswer(send, update) {
  ledgers += 1;
  // Connection housekeeping on its own vendor method (live-grok-tap2/basic seq 11):
  // the delivery queue, pushed as the prompt is accepted.
  send({ jsonrpc: "2.0", method: "_x.ai/queue/changed", params: { sessionId: "fake-session", entries: [{ id: `queue-${String(ledgers)}`, version: 0, kind: "prompt", text: "grok-usage", position: 0 }] } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "billed" } });
  return { stopReason: "end_turn", _meta: { totalTokens: 1000 + ledgers, modelId: "fixture-model-x", usage: { inputTokens: 100, outputTokens: 7, totalTokens: 107, cachedReadTokens: 64, cacheCreationTokens: 0, modelCalls: 1 } } };
}

/**
 * A send-now steer as grok 1.0.25 answered it (live-grok-b/steer.voyage.jsonl
 * seqs 63 and 158): the interrupted prompt answers `cancelled`
 * (`cancelTrigger: "send_now"`) with the ledger of its one model call; the
 * steering prompt answers `end_turn` with ITS OWN two calls summed
 * (`modelCalls: 2`), not a running total — so the session sum is 51196/501.
 */
export const grokSteerAnswers = {
  cancelled: {
    stopReason: "cancelled",
    _meta: {
      totalTokens: 16_998,
      modelId: "fixture-model-x",
      inputTokens: 16_776,
      outputTokens: 222,
      usage: { inputTokens: 16_776, outputTokens: 222, totalTokens: 16_998, cachedReadTokens: 640, modelCalls: 1 },
      cancellationCategory: "MidTurnAbort",
      cancellationContext: { trigger: "send_now" },
      cancelTrigger: "send_now",
    },
  },
  closing: {
    stopReason: "end_turn",
    _meta: {
      totalTokens: 17_405,
      modelId: "fixture-model-x",
      inputTokens: 17_318,
      outputTokens: 87,
      usage: { inputTokens: 34_420, outputTokens: 279, totalTokens: 34_699, cachedReadTokens: 19_968, modelCalls: 2 },
    },
  },
};
