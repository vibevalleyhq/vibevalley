/**
 * Fold parity goldens for the Go port (smith/observe/parity_test.go).
 *
 * Run from the repo root: `pnpm tsx smith/parity/generate.ts`. It loads record
 * logs, computes every observe fold with the TS functions, and writes one
 * golden JSON file per log under smith/parity/golden/. The Go test decodes the
 * same records, runs the Go folds and compares each field semantically.
 *
 * Record sources:
 * - the TS scripted runtime driven through scenarios (prompt, steer, queue +
 *   withdraw, abort, dispose mid-turn, tools, tasks, text coalescing);
 * - tests/replay/fixtures/codex-steer-order.records.jsonl (real records);
 * - the recorded native streams of tests/replay/fixtures/{claude,codex,pi}-*.raw.jsonl
 *   folded through the production projections into records;
 * - hand-built logs for what neither produces (child sessions, sub-agents,
 *   app requests, compaction, retry, legacy tool output, queue conflicts).
 *
 * Determinism: every UUID is replaced by a stable token in first-appearance
 * order and scripted `receivedAt` stamps are replaced by base + seq, so a
 * second run writes identical files. Every fold runs on the normalized records.
 *
 * Serialization contract (mirrored by the Go MarshalJSON methods): a Map is an
 * array of [key, value] pairs and a Set an array of values, both in insertion
 * order; undefined properties are dropped.
 *
 * This file is outside the repo's tsconfig, lint and vitest globs on purpose.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Event, RawEvent, RuntimeEventBody, RequestBody, ResponseBody, Session, SessionEdge } from "../../packages/oar/src/contracts/session.js";
import { scriptedRuntime } from "../../packages/oar/src/testing/index.js";
import type { ScriptedTask, ScriptedTurn } from "../../packages/oar/src/testing/index.js";
import { statusOf, reduceStatus, initialStatus } from "../../packages/oar/src/observe/agent-status.js";
import { coalesceText, eventsReader } from "../../packages/oar/src/observe/events.js";
import { graphOf } from "../../packages/oar/src/observe/graph.js";
import { contextUsageOf, effortOf, modelOf, serviceTierOf, usageOf } from "../../packages/oar/src/observe/usage.js";
import { awaitTurnEnd, turnEndAfter } from "../../packages/oar/src/observe/turns.js";
import { conversationOf, initialConversation, reduceConversation } from "../../packages/oar/src/observe/conversation.js";
import { initialSessionView, reduceSessionView, reduceSessionViewEvent, viewOf, type SessionView, type ViewNotice, type ViewPart } from "../../packages/oar/src/observe/session-view.js";
import { tasksOf } from "../../packages/oar/src/observe/tasks.js";
import { classifyTool, toolActionLabel } from "../../packages/oar/src/observe/tool-activity.js";
import { groupToolActivity, toolGroupSummary } from "../../packages/oar/src/observe/tool-groups.js";
import { failureText, noticeText, noticeTone, phaseLabel, taskStatusLabel } from "../../packages/oar/src/observe/display-text.js";
import { failureAdvice } from "../../packages/oar/src/observe/failure-advice.js";
import { appRequestKind, appRequestText } from "../../packages/oar/src/observe/app-requests.js";
import { claudePrompted, foldClaudeStdout, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";
import { foldCodexNotification, initialCodexProjection } from "../../packages/oar/src/runtimes/codex/projection.js";
import { foldPiEvent, initialPiProjection, piPrompted } from "../../packages/oar/src/runtimes/pi/projection.js";

const here = import.meta.dirname;
const repo = path.resolve(here, "../..");
const goldenDir = path.join(here, "golden");
const replay = path.join(repo, "tests/replay/fixtures");
const BASE_TIME = 1_800_000_000_000;

interface Log {
  readonly name: string;
  readonly source: string;
  /** For classifyTool and phase labels. */
  readonly runtimeId: string;
  readonly records: readonly RawEvent[];
  /** Keep receivedAt as recorded (fixtures already deterministic). */
  readonly keepTimes?: boolean;
}

// ─── Serialization ─────────────────────────────────────────────────────────

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) { return [...value.entries()]; }
  if (value instanceof Set) { return [...value.values()]; }
  return value;
}

function plain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value, replacer));
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

function normalize(records: readonly RawEvent[], keepTimes: boolean): RawEvent[] {
  const tokens = new Map<string, string>();
  const text = JSON.stringify(records).replaceAll(UUID, (uuid) => {
    const key = uuid.toLowerCase();
    let token = tokens.get(key);
    if (token === undefined) {
      token = `uuid-${String(tokens.size + 1).padStart(4, "0")}`;
      tokens.set(key, token);
    }
    return token;
  });
  const parsed = JSON.parse(text) as RawEvent[];
  return keepTimes ? parsed : parsed.map((record) => ({ ...record, receivedAt: BASE_TIME + record.seq * 100 }));
}

// ─── Scripted scenarios ────────────────────────────────────────────────────

interface Gate { readonly wait: Promise<void>; readonly open: () => void }
function gate(): Gate {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

async function scripted(turn: (t: ScriptedTurn) => void | Promise<void>, drive: (session: Session) => Promise<void>): Promise<RawEvent[]> {
  const runtime = scriptedRuntime({ turn });
  const installation = await runtime.installation?.();
  if (installation?.kind !== "available") { throw new Error("scripted runtime unavailable"); }
  const session = await runtime.session(installation, { cwd: repo });
  await drive(session);
  return [...session.records()];
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) { await new Promise<void>((resolve) => { setImmediate(resolve); }); }
}

async function scriptedLogs(): Promise<Log[]> {
  const logs: Log[] = [];
  const add = (name: string, records: RawEvent[]): void => { logs.push({ name: `scripted-${name}`, source: "packages/oar/src/testing scriptedRuntime", runtimeId: "scripted", records }); };

  // Prompt: reasoning, text pieces (coalescing), tools ok / failed / content blocks, then a failed turn.
  add("prompt", await scripted(async (t) => {
    if (t.input === "boom") { t.say("about to fail"); throw new Error("boom"); }
    t.think("let me "); t.think("think");
    t.say("Hel"); t.say("lo"); t.say(" world");
    await t.tool("read", JSON.stringify({ path: "/tmp/a.txt" }), () => "file body");
    await t.tool("bash", JSON.stringify({ command: "ls -la" }), () => [{ type: "text", text: "a" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "resource", uri: "x" }]);
    try { await t.tool("bash", JSON.stringify({ command: "false" }), () => { throw new Error("exit 1"); }); } catch { /* a failed tool, the turn goes on */ }
    await t.tool("mcp__srv__echo", JSON.stringify({ text: "hi" }), () => ({ structured: true }));
    t.say("done");
  }, async (session) => {
    const first = await session.prompt("hello", { inputId: "11111111-0000-4000-8000-000000000001" });
    await awaitTurnEnd(session, first.seq);
    const second = await session.prompt("boom", { inputId: "11111111-0000-4000-8000-000000000002", origin: { kind: "user" } });
    await awaitTurnEnd(session, second.seq);
    await session.dispose();
  }));

  // Steer into a running turn; controls refused while idle.
  {
    const g = gate();
    add("steer", await scripted(async (t) => {
      t.say("working");
      await g.wait;
      t.say(`steered: ${t.steered.join(" | ")}`);
    }, async (session) => {
      const first = await session.prompt("work", { inputId: "22222222-0000-4000-8000-000000000001" });
      await settle();
      await session.steer?.("also this", { inputId: "22222222-0000-4000-8000-000000000002" });
      await session.steer?.("and that", { inputId: "22222222-0000-4000-8000-000000000003", origin: { kind: "notification", source: "ci" } });
      const busy = await session.prompt("too soon", { inputId: "22222222-0000-4000-8000-000000000004" });
      void busy;
      g.open();
      await awaitTurnEnd(session, first.seq);
      await session.steer?.("late", { inputId: "22222222-0000-4000-8000-000000000005" });
      await session.abort();
      await session.dispose();
    }));
  }

  // Queue behind a running turn, withdraw one entry, withdraw an unknown one.
  {
    const g = gate();
    add("queue-withdraw", await scripted(async (t) => {
      if (t.input === "first") { await g.wait; }
      t.say(`ran ${t.input}`);
    }, async (session) => {
      await session.prompt("first", { inputId: "33333333-0000-4000-8000-000000000001" });
      await settle();
      const second = await session.queue("second", { inputId: "33333333-0000-4000-8000-000000000002" });
      await session.queue("third", { inputId: "33333333-0000-4000-8000-000000000003" });
      await session.withdraw?.("33333333-0000-4000-8000-000000000003");
      await session.withdraw?.("33333333-0000-4000-8000-00000000ffff");
      g.open();
      await awaitTurnEnd(session, second.seq, "33333333-0000-4000-8000-000000000002");
      await settle();
      // A queue while idle starts its turn at once.
      const idle = await session.queue("fourth", { inputId: "33333333-0000-4000-8000-000000000004" });
      await awaitTurnEnd(session, idle.seq);
      await session.dispose();
    }));
  }

  // Abort with a tool in flight, then a fresh turn.
  {
    const g = gate();
    add("abort", await scripted(async (t) => {
      if (t.input === "long") {
        t.say("starting");
        await t.tool("bash", JSON.stringify({ command: "sleep 100" }), () => g.wait);
        return;
      }
      t.say("short one");
    }, async (session) => {
      const first = await session.prompt("long", { inputId: "44444444-0000-4000-8000-000000000001" });
      await settle();
      await session.abort();
      await awaitTurnEnd(session, first.seq);
      g.open();
      await settle();
      const second = await session.prompt("short", { inputId: "44444444-0000-4000-8000-000000000002" });
      await awaitTurnEnd(session, second.seq);
      await session.dispose();
    }));
  }

  // Dispose mid-turn: a tool in flight and a background task.
  {
    const g = gate();
    add("dispose-mid-turn", await scripted(async (t) => {
      t.task({ taskType: "shell", description: "watch", background: true });
      t.think("about to run");
      await t.tool("bash", JSON.stringify({ command: "make" }), () => g.wait);
    }, async (session) => {
      await session.prompt("go", { inputId: "55555555-0000-4000-8000-000000000001" });
      await settle();
      await session.dispose();
      g.open();
      await settle();
    }));
  }

  // Tasks across turns: updates, ends with summaries, one left running at exit.
  {
    let build: ScriptedTask | undefined;
    add("tasks", await scripted(async (t) => {
      if (t.input === "start") {
        build = t.task({ taskType: "shell", description: "build", background: true });
        build.update({ status: "running", description: "build (2 steps)" });
        const helper = t.task({ taskType: "agent", description: "helper" });
        helper.update({ status: "paused" });
        helper.end("completed", { summary: "helped", outputFile: "/tmp/helper.out" });
        t.task({ taskType: "workflow" });
        t.say("started tasks");
        return;
      }
      build?.end("failed", { summary: "build broke" });
      const again = t.task({ taskType: "tool", description: "retry build" });
      again.update({ status: "pending" });
      t.say("rebuilding");
    }, async (session) => {
      const first = await session.prompt("start", { inputId: "66666666-0000-4000-8000-000000000001" });
      await awaitTurnEnd(session, first.seq);
      const second = await session.prompt("check", { inputId: "66666666-0000-4000-8000-000000000002" });
      await awaitTurnEnd(session, second.seq);
      await session.dispose();
    }));
  }

  // Text coalescing across lanes: text, reasoning, text again, a tool between.
  add("coalesce", await scripted(async (t) => {
    for (const piece of ["a", "b", "c"]) { t.say(piece); }
    for (const piece of ["x", "y"]) { t.think(piece); }
    t.say("d");
    await t.tool("noop", "", () => undefined);
    t.say("e"); t.say("f");
  }, async (session) => {
    const run = await session.prompt("stream", { inputId: "77777777-0000-4000-8000-000000000001" });
    await awaitTurnEnd(session, run.seq);
    await session.dispose();
  }));

  return logs;
}

// ─── A tiny record builder (the kernel's envelope, deterministic) ──────────

interface At { readonly sessionId?: string; readonly agentPath?: readonly string[]; readonly spanId?: string }

class Builder {
  readonly records: RawEvent[] = [];
  private seq = 0;
  private ids = 0;
  constructor(readonly sessionId: string, private readonly step = 10) {}
  private envelope(at: At = {}): { sessionId: string; agentPath: readonly string[]; spanId?: string; seq: number; receivedAt: number } {
    const seq = this.seq;
    this.seq += 1;
    return { sessionId: at.sessionId ?? this.sessionId, agentPath: at.agentPath ?? [], ...(at.spanId === undefined ? {} : { spanId: at.spanId }), seq, receivedAt: BASE_TIME + seq * this.step };
  }
  frame(type: string, events: readonly RuntimeEventBody[], at?: At, native: unknown = {}): RawEvent {
    const record = { ...this.envelope(at), kind: "frame", body: { type, native, events } } as RawEvent;
    this.records.push(record);
    return record;
  }
  request(direction: "toRuntime" | "toApp", body: RequestBody, at?: At & { id?: string }): string {
    this.ids += 1;
    const id = at?.id ?? `req-${String(this.ids)}`;
    this.records.push({ ...this.envelope(at), kind: "request", id, direction, body } as RawEvent);
    return id;
  }
  respond(requestId: string, body: ResponseBody, at?: At): void {
    this.records.push({ ...this.envelope(at), kind: "response", requestId, body } as RawEvent);
  }
  control(body: RequestBody, response: ResponseBody, at?: At): string {
    const id = this.request("toRuntime", body, at);
    this.respond(id, response, at);
    return id;
  }
}

const accepted: ResponseBody = { kind: "accepted" };

function syntheticLogs(): Log[] {
  const logs: Log[] = [];
  const add = (name: string, runtimeId: string, builder: Builder): void => {
    logs.push({ name: `synthetic-${name}`, source: "hand-built records (smith/parity/generate.ts)", runtimeId, records: builder.records, keepTimes: true });
  };

  // Child sessions, sub-agents, usage totals, notices, app requests, legacy output, exit.
  {
    const b = new Builder("root");
    b.frame("init", [{ kind: "model", model: "m-1" }, { kind: "effort", effort: "high" }, { kind: "service_tier", serviceTier: "flex" }]);
    b.control({ kind: "prompt", input: "do it", inputId: "in-1" }, accepted);
    b.frame("turn", [{ kind: "turn_active", inputId: "in-1" }]);
    b.frame("usage", [{ kind: "usage", usage: { context: { tokens: 100, contextWindow: 1000, percent: 10 }, tokens: { input: 10, output: 2, cacheRead: 4 } } }]);
    b.frame("reasoning", [{ kind: "reasoning", content: { kind: "redacted" } }, { kind: "reasoning", content: { kind: "text", text: "plan " }, messageId: "r1" }]);
    b.frame("text", [{ kind: "text_delta", text: "Hi ", messageId: "m1" }]);
    b.frame("tool", [{ kind: "tool_call_started", callId: "c1", tool: "Bash" }]);
    b.frame("tool-input", [{ kind: "tool_call_input_delta", callId: "c1", delta: "{\"comm" }, { kind: "tool_call_input_delta", callId: "c1", delta: "and\":\"ls\"}" }]);
    b.frame("tool-input", [{ kind: "tool_call_input", callId: "c1", input: "{\"command\":\"ls\",\"description\":\"list\"}" }]);
    b.frame("progress", [{ kind: "tool_call_progress", callId: "c1", output: "a\n" }, { kind: "tool_call_progress", callId: "c1", outputDelta: "b\n" }]);
    b.frame("reasoning", [{ kind: "reasoning", content: { kind: "text", text: "more" }, messageId: "r1" }]);
    b.frame("text", [{ kind: "text_delta", text: "there", messageId: "m1" }]);
    b.frame("tool-end", [{ kind: "tool_call_ended", callId: "c1", content: [{ type: "text", text: "a\nb\n" }], result: "ok", exitCode: 0 }]);
    // A sub-agent of the root session.
    b.frame("agent", [{ kind: "tool_call_started", callId: "task-1", tool: "Agent", input: "{\"description\":\"helper\",\"prompt\":\"x\"}" }]);
    b.frame("agent", [{ kind: "text_delta", text: "child says" }], { agentPath: ["task-1"] });
    b.frame("agent", [{ kind: "tool_call_started", callId: "c2", tool: "Read", input: "{\"file_path\":\"/x\"}" }], { agentPath: ["task-1"] });
    b.frame("agent", [{ kind: "tool_call_ended", callId: "c2", output: "[{\"type\":\"text\",\"text\":\"legacy\"}]" } as unknown as RuntimeEventBody], { agentPath: ["task-1"] });
    b.frame("agent", [{ kind: "usage", usage: { tokens: { input: 5, output: 1 } } }], { agentPath: ["task-1"] });
    b.frame("agent", [{ kind: "turn_ended", outcome: { kind: "completed" } }], { agentPath: ["task-1"] });
    b.frame("agent", [{ kind: "task_started", taskId: "t-1", taskType: "agent", description: "helper", toolCallId: "task-1" }]);
    // A derived child session.
    b.frame("link", [{ kind: "session_linked", parent: "root", child: "kid", via: "tool_call" }]);
    b.frame("kid", [{ kind: "turn_active" }, { kind: "model", model: "kid-model" }], { sessionId: "kid", spanId: "kt" });
    b.frame("kid", [{ kind: "text_delta", text: "kid text" }, { kind: "usage", usage: { tokens: { input: 7, output: 3 }, context: { tokens: 1, contextWindow: null, percent: null } } }], { sessionId: "kid" });
    b.frame("kid", [{ kind: "turn_ended", outcome: { kind: "failed", failure: "rate_limited", reason: "slow down", status: 429 } }], { sessionId: "kid" });
    b.frame("kid", [{ kind: "task_updated", taskId: "kt-9", status: "running" }], { sessionId: "kid" });
    // Notices.
    b.frame("compact", [{ kind: "compaction_started", trigger: "auto" }]);
    b.frame("compact", [{ kind: "compaction_ended", outcome: "completed", trigger: "auto" }]);
    b.frame("retry", [{ kind: "retry", attempt: 1, maxAttempts: 5, delayMs: 1500, reason: "overloaded" }]);
    b.frame("retry", [{ kind: "retry", attempt: 2 }]);
    // Runtime → app requests: one answered, one cancelled, one left pending.
    const approval = b.request("toApp", { kind: "native", type: "can_use_tool", native: { request: { tool_name: "Bash", input: { command: "rm -rf /" } } } }, { id: "app-1" });
    b.respond(approval, { kind: "answered", native: { behavior: "allow" } });
    b.request("toApp", { kind: "native", type: "elicitation", native: { request: { message: "Which one?" } } }, { id: "app-2" });
    b.frame("cancel", [{ kind: "app_request_cancelled", requestId: "app-2" }]);
    b.request("toApp", { kind: "native", type: "item/commandExecution/requestApproval", native: { command: "make" } }, { id: "app-3", agentPath: ["task-1"] });
    b.frame("usage", [{ kind: "usage", usage: { tokens: { input: 20, output: 4, cacheRead: 4, reasoning: 1 }, total: { input: 40, output: 9 } } }]);
    b.frame("task", [{ kind: "task_ended", taskId: "t-1", status: "completed", summary: "ok" }]);
    b.frame("end", [{ kind: "turn_ended", outcome: { kind: "completed", structuredOutput: { answer: 42 } } }]);
    // A second turn the process does not survive.
    b.control({ kind: "prompt", input: "again", inputId: "in-2", images: [{ path: "/tmp/a.png", mediaType: "image/png" }] }, accepted);
    b.frame("tool", [{ kind: "tool_call_started", callId: "c3", tool: "WebFetch", input: "{\"url\":\"https://x\"}" }]);
    b.frame("task", [{ kind: "task_started", taskId: "t-2", taskType: "shell", background: true, ambient: false }]);
    b.request("toApp", { kind: "native", type: "session/request_permission", native: { toolCall: { title: "fetch" } } }, { id: "app-4" });
    b.respond("exit", { kind: "exited", code: 1 });
    b.frame("late", [{ kind: "task_ended", taskId: "t-2", status: "completed" }]);
    add("children", "claude", b);
  }

  // Input evidence: echoes, steer and queue attribution, drops, refusals, exit and restore.
  {
    const b = new Builder("thr");
    b.control({ kind: "prompt", input: "first", inputId: "p1" }, accepted);
    b.frame("turn/started", [{ kind: "turn_active", inputId: "p1" }], { spanId: "t1" });
    b.frame("item/userMessage", [{ kind: "user_message", input: "first", inputId: "p1", nativeMessageId: "u1", evidence: "turn_item" }], { spanId: "t1" });
    b.frame("item/userMessage", [{ kind: "user_message", input: "first", inputId: "p1", nativeMessageId: "u1", evidence: "turn_item" }], { spanId: "t1" });
    b.frame("item/agentMessage", [{ kind: "text_delta", text: "one", messageId: "a1" }], { spanId: "t1" });
    b.control({ kind: "steer", input: "nudge", inputId: "s1" }, accepted);
    b.frame("item/agentMessage", [{ kind: "text_delta", text: " two", messageId: "a1" }], { spanId: "t1" });
    b.frame("item/userMessage", [{ kind: "user_message", input: "nudge", inputId: "s1", nativeMessageId: "u2", evidence: "turn_item" }], { spanId: "t1" });
    b.frame("item/agentMessage", [{ kind: "text_delta", text: " three", messageId: "a1" }], { spanId: "t1" });
    b.control({ kind: "steer", input: "refused", inputId: "s2" }, { kind: "rejected", code: "runtime_refused", reason: "not now" });
    b.control({ kind: "queue", input: "later", inputId: "q1" }, accepted);
    b.frame("queued", [{ kind: "input_queued", inputId: "q1" }]);
    b.control({ kind: "queue", input: "dropme", inputId: "q2" }, accepted);
    b.frame("queued", [{ kind: "input_queued", inputId: "q2" }]);
    b.frame("dropped", [{ kind: "input_dropped", inputId: "q2", reason: "runtime_refused", failure: "invalid_request", message: "bad input" }]);
    b.frame("turn/completed", [{ kind: "turn_ended", outcome: { kind: "completed" } }], { spanId: "t1" });
    b.frame("turn/started", [{ kind: "turn_active", inputId: "q1" }], { spanId: "t2" });
    b.frame("item/userMessage", [{ kind: "user_message", input: "later", inputId: "q1", evidence: "conversation" }], { spanId: "t2" });
    b.frame("item/agentMessage", [{ kind: "text_delta", text: "queued ran" }], { spanId: "t2" });
    b.control({ kind: "abort" }, accepted);
    b.frame("turn/completed", [{ kind: "turn_ended", outcome: { kind: "aborted" } }], { spanId: "t2" });
    b.frame("item/userMessage", [{ kind: "user_message", input: "stray", evidence: "conversation" }]);
    b.frame("item/userMessage", [{ kind: "user_message", input: "foreign", inputId: "x9", evidence: "acknowledged" }]);
    b.control({ kind: "prompt", input: "busy one", inputId: "p2" }, accepted);
    b.control({ kind: "steer", input: "lost", inputId: "s3" }, accepted);
    b.control({ kind: "withdraw", inputId: "s3" }, { kind: "rejected", code: "not_queued", reason: "not held" });
    b.frame("turn/started", [{ kind: "turn_active", inputId: "p2" }], { spanId: "t3" });
    b.request("toRuntime", { kind: "dispose" });
    b.respond("dispose", { kind: "exited", code: null });
    // A resumed transcript (new stream in a host) echoes the lost steer.
    b.frame("resume", [{ kind: "user_message", input: "lost", inputId: "s3", nativeMessageId: "u9", evidence: "conversation" }]);
    add("inputs", "codex", b);
  }

  // A prompt held behind a spontaneous turn, rejections and a mid-turn subscriber.
  {
    const b = new Builder("q");
    b.frame("orphan", [{ kind: "tool_call_progress", callId: "z1", outputDelta: "partial" }]);
    b.frame("orphan", [{ kind: "tool_call_ended", callId: "z1", result: "failed", exitCode: null }]);
    b.frame("orphan", [{ kind: "tool_call_input", callId: "z2", input: "{}" }, { kind: "tool_call_input_delta", callId: "z3", delta: "{" }]);
    b.frame("orphan", [{ kind: "turn_ended", outcome: { kind: "failed", failure: "auth", reason: "login", credential: "missing" } }]);
    b.control({ kind: "prompt", input: "held", inputId: "h1" }, accepted);
    b.frame("queued", [{ kind: "input_queued", inputId: "h1" }]);
    b.frame("spontaneous", [{ kind: "turn_active", inputId: "other" }]);
    b.frame("spontaneous", [{ kind: "text_delta", text: "notification work" }]);
    b.control({ kind: "prompt", input: "too soon", inputId: "h2" }, { kind: "rejected", code: "busy", reason: "busy" });
    b.control({ kind: "steer", input: "nope" }, { kind: "rejected", code: "unsupported", reason: "cannot steer" });
    b.frame("spontaneous", [{ kind: "turn_ended", outcome: { kind: "completed" } }]);
    b.control({ kind: "abort" }, { kind: "rejected", code: "no_active_turn", reason: "idle" });
    b.frame("started", [{ kind: "turn_active", inputId: "h1" }]);
    b.frame("text", [{ kind: "text_delta", text: "held ran" }, { kind: "reasoning", content: { kind: "empty" } }]);
    b.frame("tool", [{ kind: "tool_call_started", callId: "k1", tool: "sleep", input: "{\"durationMs\":5000}" }]);
    b.frame("end", [{ kind: "turn_ended", outcome: { kind: "failed", failure: "quota", reason: "limit", resetsAt: "2026-10-14T00:00:00.000Z" } }]);
    b.control({ kind: "queue", input: "idle queue", inputId: "h3" }, accepted);
    b.frame("dropped", [{ kind: "input_dropped", inputId: "h3", reason: "turn_interrupted" }]);
    b.control({ kind: "prompt", input: "refused", inputId: "h4" }, accepted);
    b.frame("dropped", [{ kind: "input_dropped", inputId: "h4", reason: "runtime_refused" }]);
    b.control({ kind: "prompt", input: "after", inputId: "h5" }, accepted);
    b.control({ kind: "abort" }, accepted);
    b.respond("gone", { kind: "exited", code: null });
    add("held-prompt", "codex", b);
  }

  // A refused steer retried on an echoing stream; tasks ended and running again.
  {
    const b = new Builder("echo");
    b.control({ kind: "prompt", input: "go", inputId: "e1" }, accepted);
    b.frame("turn", [{ kind: "turn_active", inputId: "e1" }, { kind: "user_message", input: "go", inputId: "e1", evidence: "turn_item" }]);
    b.frame("text", [{ kind: "text_delta", text: "before" }]);
    b.frame("task", [{ kind: "task_started", taskId: "bg", taskType: "shell", description: "server" }]);
    b.frame("task", [{ kind: "task_ended", taskId: "bg", status: "completed", summary: "up", outputFile: "/tmp/bg.log" }]);
    b.control({ kind: "steer", input: "retry me", inputId: "r1" }, { kind: "rejected", code: "runtime_refused", reason: "later" });
    b.control({ kind: "steer", input: "retry me", inputId: "r1" }, accepted);
    b.frame("text", [{ kind: "text_delta", text: " after" }]);
    b.frame("task", [{ kind: "task_updated", taskId: "bg", status: "running", description: "server again" }]);
    b.frame("echo", [{ kind: "user_message", input: "retry me", inputId: "r1", evidence: "turn_item" }]);
    b.frame("task", [{ kind: "task_updated", taskId: "bg", error: "port in use" }]);
    b.frame("end", [{ kind: "turn_ended", outcome: { kind: "completed" } }]);
    b.request("toRuntime", { kind: "dispose" });
    b.respond("dispose", { kind: "exited", code: 0 });
    b.frame("task", [{ kind: "task_ended", taskId: "bg", status: "failed" }]);
    add("retry", "codex", b);
  }
  return logs;
}

// ─── Recorded native streams through the production projections ───────────

function lines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0);
}

function claudeLog(scenario: string): Log {
  const b = new Builder("claude-session", 5);
  b.control({ kind: "prompt", input: `replay ${scenario}`, inputId: "claude-input" }, accepted);
  let state = claudePrompted(initialClaudeProjection, "claude-input");
  for (const line of lines(path.join(replay, `claude-${scenario}.raw.jsonl`))) {
    const message = JSON.parse(line) as Record<string, unknown>;
    const folded = foldClaudeStdout(state, message);
    state = folded.state;
    for (const command of folded.commands) {
      switch (command.kind) {
        case "frame": b.frame(command.body.type, command.body.events, { agentPath: command.agentPath }, command.body.native); break;
        case "respond": b.respond(command.requestId, command.body); break;
        case "toApp": b.request("toApp", { kind: "native", type: command.type, native: command.native }, { id: command.id }); break;
      }
    }
  }
  return { name: `replay-claude-${scenario}`, source: `tests/replay/fixtures/claude-${scenario}.raw.jsonl via foldClaudeStdout`, runtimeId: "claude", records: b.records, keepTimes: true };
}

function codexLog(scenario: string): Log {
  const root = "thread-root";
  const b = new Builder(root, 5);
  b.control({ kind: "prompt", input: `replay ${scenario}`, inputId: "codex-input" }, accepted);
  let state = initialCodexProjection(root);
  const known: SessionEdge[] = [];
  for (const line of lines(path.join(replay, `codex-${scenario}.raw.jsonl`))) {
    const frame = JSON.parse(line) as Record<string, unknown>;
    if (typeof frame.method !== "string") { continue; }
    const folded = foldCodexNotification(state, frame.method, frame);
    state = folded.state;
    const links: RuntimeEventBody[] = [];
    for (const command of folded.commands) {
      if (command.kind === "link" && !known.some((edge) => edge.parent === command.edge.parent && edge.child === command.edge.child)) {
        known.push(command.edge);
        links.push({ kind: "session_linked", parent: command.edge.parent, child: command.edge.child, via: command.edge.via });
      }
    }
    for (const command of folded.commands) {
      if (command.kind === "frame") {
        b.frame(command.body.type, [...command.body.events, ...links], {
          ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
          ...(command.spanId === undefined ? {} : { spanId: command.spanId }),
        }, command.body.native);
      }
    }
  }
  return { name: `replay-codex-${scenario}`, source: `tests/replay/fixtures/codex-${scenario}.raw.jsonl via foldCodexNotification`, runtimeId: "codex", records: b.records, keepTimes: true };
}

function piLog(scenario: string): Log {
  const b = new Builder("pi-session", 5);
  b.control({ kind: "prompt", input: `replay ${scenario}`, inputId: "pi-input" }, accepted);
  let state = piPrompted(initialPiProjection);
  for (const line of lines(path.join(replay, `pi-${scenario}.raw.jsonl`))) {
    const folded = foldPiEvent(state, JSON.parse(line) as never);
    state = folded.state;
    for (const command of folded.commands) {
      b.frame(command.body.type, command.body.events, {}, command.body.native);
    }
  }
  return { name: `replay-pi-${scenario}`, source: `tests/replay/fixtures/pi-${scenario}.raw.jsonl via foldPiEvent`, runtimeId: "pi", records: b.records, keepTimes: true };
}

function replayLogs(): Log[] {
  const scenarios = (prefix: string): string[] => readdirSync(replay)
    .filter((file) => file.startsWith(`${prefix}-`) && file.endsWith(".raw.jsonl") && !readdirSync(replay).includes(file.replace(".raw.jsonl", ".stdin.jsonl")))
    .map((file) => file.slice(prefix.length + 1, -".raw.jsonl".length))
    .sort();
  const logs: Log[] = [
    ...scenarios("claude").map((scenario) => claudeLog(scenario)),
    ...scenarios("codex").map((scenario) => codexLog(scenario)),
    ...scenarios("pi").map((scenario) => piLog(scenario)),
  ];
  const records = lines(path.join(replay, "codex-steer-order.records.jsonl")).map((line) => JSON.parse(line) as RawEvent);
  logs.push({ name: "records-codex-steer-order", source: "tests/replay/fixtures/codex-steer-order.records.jsonl", runtimeId: "codex", records, keepTimes: true });
  return logs;
}

// ─── The folds ─────────────────────────────────────────────────────────────

function eventsOfLog(records: readonly RawEvent[]): Event[] {
  const events: Event[] = [];
  const read = eventsReader((event) => { events.push(event); });
  for (const record of records) { read(record); }
  return events;
}

function coalesced(events: readonly Event[]): Event[] {
  const out: Event[] = [];
  const observer = coalesceText((event) => { out.push(event); });
  for (const event of events) { observer(event); }
  // A non-text sentinel flushes the last held piece; it is not part of the result.
  observer({ kind: "exited", code: null, sessionId: "sentinel", agentPath: [], seq: -1, receivedAt: 0 } as Event);
  return out.slice(0, -1);
}

function turnEndSamples(records: readonly RawEvent[], root: string): unknown[] {
  const samples: unknown[] = [{ afterSeq: -1, outcome: turnEndAfter(records, -1) }, { afterSeq: -1, sessionId: root, outcome: turnEndAfter(records, -1, root) }];
  for (const record of records) {
    if (record.kind === "request" && record.direction === "toRuntime" && "input" in record.body) {
      const inputId = record.body.inputId;
      samples.push({ afterSeq: record.seq, sessionId: record.sessionId, outcome: turnEndAfter(records, record.seq, record.sessionId) });
      if (inputId !== undefined) {
        samples.push({ afterSeq: record.seq, sessionId: record.sessionId, inputId, outcome: turnEndAfter(records, record.seq, record.sessionId, inputId) });
        samples.push({ afterSeq: record.seq, inputId, outcome: turnEndAfter(records, record.seq, undefined, inputId) });
      }
    }
  }
  return samples;
}

function notices(view: SessionView): ViewNotice[] {
  const found: ViewNotice[] = [];
  for (const message of view.messages) {
    if (message.kind === "notice") { found.push(message.notice); }
    if (message.kind === "turn") {
      for (const section of message.sections) {
        for (const part of section.parts) { if (part.kind === "notice") { found.push(part.notice); } }
      }
    }
  }
  return found;
}

function display(view: SessionView, runtimeId: string, statusSteps: readonly unknown[], tasks: readonly { status: string }[]): unknown {
  const groups: unknown[] = [];
  const tools: unknown[] = [];
  const requests: unknown[] = [];
  for (const message of view.messages) {
    if (message.kind !== "turn") { continue; }
    for (const section of message.sections) {
      const segments = groupToolActivity(runtimeId, section.parts);
      groups.push({ segments, summaries: segments.map((segment) => segment.kind === "tools" ? { done: toolGroupSummary(segment.counts), running: toolGroupSummary(segment.counts, "running") } : null) });
      for (const part of section.parts as readonly ViewPart[]) {
        if (part.kind === "tool") {
          const action = classifyTool(runtimeId, part.tool, part.inputPartial === true ? undefined : part.input);
          const state = part.result === "running" ? "running" : part.result === "failed" ? "failed" : "done";
          tools.push({ tool: part.tool, input: part.input ?? null, action, bare: classifyTool(runtimeId, part.tool), label: toolActionLabel(action.kind, state), writing: toolActionLabel(action.kind, "writing") });
        }
        if (part.kind === "app_request") {
          requests.push({ type: part.type, kind: appRequestKind(part.type), text: appRequestText(part.type, part.body) ?? null });
        }
      }
    }
  }
  const phases = statusSteps.flatMap((status) => {
    const s = status as { kind: string; phase?: unknown };
    return s.kind === "running" ? [{ phase: s.phase, label: phaseLabel(s.phase as never), runtimeLabel: phaseLabel(s.phase as never, runtimeId) }] : [];
  });
  const failures: unknown[] = [];
  const outcomes = statusSteps.flatMap((status) => {
    const outcome = (status as { lastTurnOutcome?: { kind: string; failure?: string; credential?: string } }).lastTurnOutcome;
    return outcome?.kind === "failed" && outcome.failure !== undefined ? [outcome] : [];
  });
  for (const outcome of outcomes) {
    failures.push({ failure: outcome.failure, credential: outcome.credential ?? null, text: failureText(outcome.failure as never, "Runtime", outcome.credential as never), advice: failureAdvice(outcome.failure as never) });
  }
  return {
    groups,
    tools,
    requests,
    notices: notices(view).map((notice) => ({ notice, text: noticeText(notice), tone: noticeTone(notice) })),
    phases,
    failures,
    tasks: tasks.map((task) => taskStatusLabel(task.status as never)),
  };
}

/** A compact digest of the view after every record: layout and the waiting lists, which the final view alone hides. */
function viewSteps(records: readonly RawEvent[]): unknown[] {
  const steps: unknown[] = [];
  let view = initialSessionView();
  for (const record of records) {
    view = reduceSessionView(view, record);
    steps.push({
      openTurn: view.openTurn,
      messages: view.messages.map((message) => message.kind === "turn"
        ? { id: message.id, parts: message.sections.map((section) => section.parts.length), outcome: message.outcome?.kind ?? null }
        : { id: message.id }),
      pendingInputs: view.pendingInputs.map((input) => ({ id: input.id, state: input.state })),
      pendingRequests: view.pendingRequests.map((request) => request.requestId),
      updates: view.conversation.updates.length,
    });
  }
  return steps;
}

function goldenOf(log: Log): unknown {
  const records = normalize(log.records, log.keepTimes === true);
  const root = records[0]?.sessionId ?? "";
  const both = <T>(fold: (records: readonly RawEvent[], sessionId?: string) => T): unknown => ({ all: fold(records), root: fold(records, root) });
  const statusSteps: unknown[] = [];
  let status = initialStatus;
  for (const record of records) {
    status = reduceStatus(status, record, root);
    statusSteps.push(status);
  }
  const conversationUpdates: unknown[] = [];
  let conversation = initialConversation();
  for (const record of records) {
    conversation = reduceConversation(conversation, record);
    conversationUpdates.push(conversation.updates);
  }
  const events = eventsOfLog(records);
  const view = viewOf(records);
  const tasks = tasksOf(records);
  return {
    name: log.name,
    source: log.source,
    runtimeId: log.runtimeId,
    rootSessionId: root,
    records,
    statusSteps,
    statusOf: both(statusOf),
    modelOf: both(modelOf),
    effortOf: both(effortOf),
    serviceTierOf: both(serviceTierOf),
    contextUsageOf: both(contextUsageOf),
    usageOf: both((r, s) => usageOf(r, s)),
    graphOf: graphOf(records),
    events,
    coalesced: coalesced(events),
    turnEndAfter: turnEndSamples(records, root),
    conversation: conversationOf(records),
    conversationUpdates,
    view,
    viewStream: viewOf(records, "stream-1"),
    viewSteps: viewSteps(records),
    viewEvents: events.reduce((state, event) => reduceSessionViewEvent(state, event), initialSessionView()),
    tasksOf: tasks,
    tasksOfRoot: tasksOf(records, root),
    display: display(view, log.runtimeId, statusSteps, tasks.value),
  };
}

async function main(): Promise<void> {
  const logs = [...await scriptedLogs(), ...syntheticLogs(), ...replayLogs()];
  rmSync(goldenDir, { recursive: true, force: true });
  mkdirSync(goldenDir, { recursive: true });
  for (const log of logs) {
    const golden = plain(goldenOf(log));
    writeFileSync(path.join(goldenDir, `${log.name}.json`), `${JSON.stringify(golden, null, 1)}\n`);
  }
  console.log(`wrote ${String(logs.length)} golden files to ${path.relative(repo, goldenDir)}`);
}

await main();
