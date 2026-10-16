/* oxlint-disable eslint/max-statements, eslint/max-params, eslint/max-lines-per-function, eslint/prefer-destructuring, eslint/no-underscore-dangle, import/no-nodejs-modules, unicorn/numeric-separators-style, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/no-confusing-void-expression -- Standalone untyped child-process fixture for exercising raw ACP framing. */
import { createInterface } from "node:readline";
import { grokMcpCredentials, grokSteerAnswers, grokUsageAnswer, spawnChildGrok } from "./fake-acp-grok.mjs";
import { answerConfigRequest, modelReport, setModelResponse } from "./fake-acp-model.mjs";
import { answeredMcpOpen, mcpCapabilities } from "./fake-acp-mcp.mjs";
import refuseSteer from "./fake-acp-refusal.mjs";
import grokBackgroundUsage, { grokUsageHistory } from "./fake-acp-grok-usage.mjs";

const mode = process.argv[2] ?? "session";
const pendingPrompts = new Map();
const reverseRequests = new Map();
let reverseId = 0;
const antigravity = mode === "antigravity";
// OpenCode v1: mid-turn prompts join its loop; all answers arrive at idle.
const opencode = mode === "opencode";
const sessionCapabilities = { "grok-usage-load": {}, opencode: { close: {}, fork: {}, list: {}, resume: {} }, antigravity: { list: {}, resume: {} }, listed: { list: {}, resume: {} } };
let currentMode = "default";

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

function result(id, value = {}) { send({ jsonrpc: "2.0", id, result: value }); }

function error(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function update(value, sessionId = "fake-session") {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
}

/** A runtime→client request; its answer lands in handleResponse under `kind`. */
function askClient(kind, outerId, method, params) {
  reverseId += 1;
  const id = `${kind}-${reverseId}`;
  reverseRequests.set(id, { kind, outerId });
  send({ jsonrpc: "2.0", id, method, params });
}

/** The prompt's text block; each image block before it is echoed as `[image <mimeType> <uri>]`. */
function promptText(params) {
  const prompt = Array.isArray(params?.prompt) ? params.prompt : [];
  const text = prompt.find((block) => block?.type === "text");
  const images = prompt.filter((block) => block?.type === "image").map((block) => `[image ${block.mimeType} ${block.uri}]`);
  return [...images, ...(typeof text?.text === "string" ? [text.text] : [])].join(" ");
}

// Kimi f9ca33376 modes "usage-after-response" / "usage-never": the prompt
// answers before the un-awaited usage push (or none). `used` grows each turn.
let completedTurns = 0;

function completePrompt(id, text) {
  grokMcpCredentials(send, "live", mode);
  completedTurns += 1;
  const reply = antigravity && text === "mode" ? `mode:${currentMode}` : `echo:${text}`;
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
  if (antigravity || mode === "usage-after-response" || mode === "usage-never") {
    result(id, { stopReason: "end_turn" });
    if (mode === "usage-after-response") {
      setTimeout(() => update({ sessionUpdate: "usage_update", used: completedTurns * 100, size: 1000 }), 40);
    }
    return;
  }
  update({ sessionUpdate: "usage_update", used: 250, size: 1000 });
  result(id, { stopReason: "end_turn" });
}

function handleRpcRequest(message) {
  switch (message.method) {
    case "test/echo":
      result(message.id, message.params);
      break;
    case "test/notify":
      send({ jsonrpc: "2.0", method: "fixture/notification", params: { value: 42 } });
      result(message.id);
      break;
    case "test/reverse":
      askClient("rpc", message.id, "fixture/reverse", { question: "answer me" });
      break;
    case "test/timeout":
      break;
    case "test/exit":
      process.exit(7);
      break;
    case "test/invalid":
      process.stdout.write("this is not json\n");
      result(message.id, { recovered: true });
      break;
    default:
      error(message.id, -32601, `unknown test method: ${message.method}`);
      break;
  }
}

function handleSessionPrompt(message) {
  if (message.params?._meta?.outputSchema !== undefined) { send({ jsonrpc: "2.0", method: "fixture/prompt-schema", params: message.params }); }
  const text = promptText(message.params);
  if (refuseSteer({ text, pending: pendingPrompts, id: message.id, result, error })) {
    return;
  }
  if (opencode && pendingPrompts.size > 0) {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `merged:${[...pendingPrompts.values(), text].join("+")}` } });
    for (const id of [...pendingPrompts.keys(), message.id]) {
      update({ sessionUpdate: "usage_update", used: 300, size: 1000 });
      result(id, { stopReason: "end_turn" });
    }
    pendingPrompts.clear();
    return;
  }
  if (text === "hold" || text === "steer-base" || text === "grok-steer-base") {
    pendingPrompts.set(message.id, text);
    return;
  }
  if ((text === "steer-new" || text === "grok-steer-new") && message.params?._meta?.sendNow === true) {
    const answers = text === "grok-steer-new" ? grokSteerAnswers : { cancelled: { stopReason: "cancelled", _meta: { cancelTrigger: "send_now" } }, closing: { stopReason: "end_turn" } }; // grok-: 1.0.25's real ledgers
    for (const id of pendingPrompts.keys()) {
      result(id, answers.cancelled);
    }
    pendingPrompts.clear();
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `steer:${text}` } });
    result(message.id, answers.closing);
    return;
  }
  if (text === "switch-model") {
    update(setModelResponse("switch-to-z").pushedUpdate);
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "switched" } });
    result(message.id, { stopReason: "end_turn" });
    return;
  }
  if (text === "tool") {
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "inspect" } });
    update({
      sessionUpdate: "tool_call",
      toolCallId: "call-read",
      name: "Read",
      kind: "read",
      title: "Read input.txt",
      status: "pending",
      rawInput: { path: "input.txt" },
    });
    update({ sessionUpdate: "tool_call_update", toolCallId: "call-read", status: "in_progress" });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-read",
      status: "completed",
      rawOutput: { content: "fixture-value" },
    });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tool-done" } });
    update({ sessionUpdate: "usage_update", used: 500, size: 2000 });
    result(message.id, { stopReason: "end_turn" });
    return;
  }
  if (text === "spawn-child") {
    // Grok shape: a vendor lifecycle notification names the lineage, then the
    // child's own standard updates arrive under its own session id.
    send({
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: { parentSessionId: "fake-session", sessionId: "fake-child", kind: "spawned" },
    });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child-says-hi" } }, "fake-child");
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "parent-continues" } });
    result(message.id, { stopReason: "end_turn" });
    return;
  }
  if (grokBackgroundUsage(text, { send, result, requestId: message.id })) { return; }
  if (text === "spawn-child-grok" || text === "grok-usage") {
    result(message.id, text === "grok-usage" ? grokUsageAnswer(send, update) : spawnChildGrok(send, update)); // grok 1.0.25's real frames
    return;
  }
  if (text === "permission") {
    askClient("permission", message.id, "session/request_permission", {
      sessionId: "fake-session",
      toolCall: { toolCallId: "permission-tool", title: "Permission fixture", kind: "execute", status: "pending" },
      options: [
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "always", kind: "allow_always", name: "Always allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    });
    return;
  }
  if (text === "fail") {
    error(message.id, -32000, "Authentication required");
    return;
  }
  if (text === "exit") {
    process.exit(9);
    return;
  }
  queueMicrotask(() => completePrompt(message.id, text));
}

function handleSessionRequest(message) {
  switch (message.method) {
    case "initialize":
      grokMcpCredentials(send, "opening", mode);
      result(message.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true, ...mcpCapabilities(),
          sessionCapabilities: { ...(sessionCapabilities[mode] ?? { resume: {}, close: {} }), ...(process.env.FAKE_ACP_DIRECTORIES === "1" ? { additionalDirectories: {} } : {}) },
          promptCapabilities: { image: mode !== "no-images" },
        },
        authMethods: [{ id: "cached", name: "Cached login" }],
      });
      break;
    case "authenticate":
      result(message.id);
      break;
    case "session/new":
      result(message.id, {
        sessionId: "fake-session",
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "yolo", name: "YOLO" },
          ],
        },
        ...modelReport(mode),
      });
      break;
    case "session/resume":
    case "session/load":
      grokUsageHistory(mode, send);
      result(message.id, {
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "yolo", name: "YOLO" }],
        },
        ...modelReport(mode),
      });
      break;
    case "session/list":
      result(message.id, { sessions: [{ sessionId: "fake-session", cwd: process.env.FAKE_ACP_SESSION_CWD ?? "/" }] });
      break;
    case "session/set_model":
    case "session/set_config_option":
      answerConfigRequest(message, { update, result, error }, mode);
      break;
    case "session/set_mode":
      currentMode = message.params?.modeId ?? currentMode;
      result(message.id);
      break;
    case "session/prompt":
      handleSessionPrompt(message);
      break;
    case "session/close":
      if (antigravity) {
        process.exit(3);
      }
      send({ jsonrpc: "2.0", method: "fixture/closed", params: message.params });
      result(message.id);
      break;
    default:
      error(message.id, -32601, `unknown ACP method: ${message.method}`);
      break;
  }
}

function handleResponse(message) {
  const pending = reverseRequests.get(message.id);
  if (pending === undefined) {
    return;
  }
  reverseRequests.delete(message.id);
  if (pending.kind === "rpc") {
    result(pending.outerId, { reverse: message.result });
    return;
  }
  const optionId = message.result?.outcome?.optionId ?? "cancelled";
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `permission:${optionId}` } });
  result(pending.outerId, { stopReason: "end_turn" });
}

function handleNotification(message) {
  if (message.method === "session/cancel") {
    for (const id of pendingPrompts.keys()) {
      result(id, { stopReason: "cancelled" });
    }
    pendingPrompts.clear();
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && typeof message.method !== "string") {
    handleResponse(message);
    return;
  }
  if (message.id === undefined) {
    handleNotification(message);
    return;
  }
  if (mode === "rpc") {
    handleRpcRequest(message);
  } else if (!answeredMcpOpen(message, error)) {
    handleSessionRequest(message);
  }
});
