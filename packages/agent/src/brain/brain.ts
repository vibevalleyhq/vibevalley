import { join } from "node:path";

import type { ModelClient } from "@vibevalley/ai/client";
import type { ToolCall, ToolDeclaration, Usage } from "@vibevalley/ai/messages";
import type { ThinkingLevel } from "@vibevalley/ai/models";
import { abortable, type Clock, Hub, isAbort, type Subscription, systemClock, TaskGroup } from "@vibevalley/async";

import {
  type BrainMessage,
  type CompactionSummaryMessage,
  type CustomMessage,
  customMessage,
  messageText,
  requestContext,
  userMessage,
} from "../base/messages.ts";
import { changedParts, joinParts, prefixHashes, type PromptPart } from "../base/prefix.ts";
import { agent as words } from "../base/prompts.ts";
import { AgentBusy, AgentClosed, CannotContinue, toolFailed } from "../core/errors.ts";
import { type Agent, type AgentEvent, make, type Tool } from "../core/loop.ts";
import { stopped } from "../core/tool.ts";
import type { AgentFs } from "../infra/fs.ts";
import { type AgentLog, consoleLog } from "../infra/log.ts";
import { type McpServer, connectAll } from "../infra/mcp.ts";
import { fileMemory, type MemoryPort } from "../tools/memory.ts";
import { makeReminders } from "../tools/reminders.ts";
import { type Subagent, selfTools, subagentInstructions, subagentTool } from "../tools/self.ts";
import { defaultSkillDirs, scanSkills, type SkillInfo, skillIndex } from "../tools/skills.ts";
import { finished, type Todo } from "../tools/todo.ts";
import type { TodoStore } from "../tools/todoStore.ts";
import { type TodoRunner, makeTodoRunner, todoTools, watchedStore } from "../tools/todoTools.ts";
import { applyPlan, type Compacted, type CompactionOptions, compactInPlace, estimateTokens, planCompaction, type Summarized } from "./compaction.ts";
import { RunAccounting, type RunResult, type RunSnapshot } from "./run.ts";
import { fileTranscriptStore, loadSession, type TranscriptStore } from "./session.ts";

type Own = CustomMessage | CompactionSummaryMessage;

export type CoreEvent = AgentEvent<Own>;

export type BrainEvent =
  | CoreEvent
  | { readonly type: "agent_settled"; readonly run: RunResult; readonly progress: RunSnapshot }
  | { readonly type: "compaction_start"; readonly reason: FoldReason }
  /** `compaction` and `usage` are absent when compaction produced no summary. */
  | {
      readonly type: "compaction_end";
      readonly reason: FoldReason;
      readonly compaction?: CompactionSummaryMessage;
      readonly usage?: Usage;
    }
  /** Emitted when system-prompt sections change between non-compacted requests. */
  | { readonly type: "prefix_changed"; readonly parts: string[] }
  | { readonly type: "todos_changed"; readonly todos: Todo[] }
  | { readonly type: "agent_closed" };

type FoldReason = "threshold" | "idle";

export interface BrainOptions {
  readonly name: string;
  readonly instructions: string;
  readonly llm: ModelClient;
  readonly thinkingLevel?: ThinkingLevel;
  readonly home: string;
  readonly cwd: string;
  readonly fs?: AgentFs;
  /** Timestamps, how old a conversation is, when an idle fold and a reminder come. Default: the system clock. */
  readonly clock?: Clock;
  /** What goes wrong that the agent carries on without. Default: the console. */
  readonly log?: AgentLog;
  readonly transcript?: TranscriptStore;
  readonly tools?: readonly Tool[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: readonly McpServer[];
  readonly skills?: readonly string[];
  readonly noSkills?: boolean;
  readonly noMemory?: boolean;
  readonly memory?: MemoryPort;
  /** Defaults to 40. */
  readonly maxSteps?: number;
  /** Estimated token budget before threshold compaction; defaults to 120_000. */
  readonly contextTokens?: number;
  /** Defaults to 12. */
  readonly keepRecent?: number;
  /** Estimated token threshold for idle compaction; defaults to `4/5 * contextTokens`. */
  readonly idleFoldAt?: number;
  /** Defaults to 10 minutes; `< 0` disables idle compaction. */
  readonly idleFoldAfterMs?: number;
  /** Asked before an idle fold: true when the agent will be woken within that long anyway, and its first request folds if it must. */
  readonly wakeSoon?: (withinMs: number) => boolean;
  readonly session?: string;
  /** Disables JSONL transcript persistence (used for subagents). */
  readonly noSession?: boolean;
  readonly noSubagents?: boolean;
  readonly todos?: TodoStore;
  /** Defaults to 3. */
  readonly maxSubagents?: number;
  /** Defaults to 3. */
  readonly maxNudges?: number;
  readonly reminders?: boolean;
}

interface McpStatus {
  readonly toolCount: number;
  readonly failed: string[];
}

export const resumedUnknown = words.resumedUnknown;

const taskMessage = (text: string, now: number) => customMessage("task", text, now);

const allowed = (tools: readonly Tool[], disallowed: readonly string[] = []) => tools.filter((t) => !disallowed.includes(t.name));

const declared = (tools: readonly Tool[]): ToolDeclaration[] => tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

interface Folded {
  readonly result?: Compacted;
  readonly fresh: boolean;
}

function unfinished(messages: readonly BrainMessage[]): {
  missing: ToolCall[];
  ok: boolean;
} {
  const last = messages.at(-1);
  if (!last) return { missing: [], ok: false };
  switch (last.role) {
    case "assistant": {
      if (last.stopReason === "aborted" || last.stopReason === "error") return { missing: [], ok: false };
      const calls = last.content.filter((c): c is ToolCall => c.type === "toolCall");
      return { missing: calls, ok: calls.length > 0 };
    }
    case "toolResult": {
      const text = messageText(last);
      if (last.isError && (text === stopped || text === "Operation aborted")) return { missing: [], ok: false };
      for (let i = messages.length - 1; i >= 0; i--) {
        const answer = messages[i];
        if (answer?.role !== "assistant") continue;
        const answered = new Set(messages.slice(i + 1).flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])));
        return {
          missing: answer.content.filter((c): c is ToolCall => c.type === "toolCall" && !answered.has(c.id)),
          ok: true,
        };
      }
      return { missing: [], ok: true };
    }
    case "user":
    case "custom":
      return { missing: [], ok: true };
    case "compactionSummary":
      return { missing: [], ok: false };
  }
}

export const sessionUnfinished = async (file: string, fs?: AgentFs): Promise<boolean> => unfinished(await loadSession(file, fs)).ok;

const sameMessages = (a: readonly BrainMessage[], b: readonly BrainMessage[]) => a.length === b.length && a.at(-1)?.timestamp === b.at(-1)?.timestamp;

export interface Brain extends AsyncDisposable {
  /** Starts a run when idle, or steers into the active run. */
  readonly send: (message: BrainMessage) => Promise<void>;
  /** Starts a run when idle, or queues as a follow-up after the active run. */
  readonly later: (message: BrainMessage) => Promise<void>;
  /** The run's answer once it settles; AgentClosed when the agent is closed. The signal stops the waiting, not the run. */
  readonly ask: (message: BrainMessage, signal?: AbortSignal) => Promise<string>;
  /** Its events, in order, from the moment this is called; it ends after agent_closed. */
  readonly events: () => Subscription<BrainEvent>;
  readonly busy: () => boolean;
  readonly progress: () => RunSnapshot;
  readonly stop: () => Promise<void>;
  readonly history: () => BrainMessage[];
  readonly queued: () => Promise<boolean>;
  readonly tools: () => readonly Tool[];
  readonly reset: () => Promise<void>;
  readonly skills: () => Promise<SkillInfo[]>;
  readonly mcpStatus: () => McpStatus;
  /** Diff of `MEMORY.md` (`+` / `−` lines) since last seen by the model, or `""` when unchanged. */
  readonly memoryNews: () => Promise<string>;
  readonly resume: (maxAgeMs: number) => Promise<boolean>;
  /** Stops the run under way and settles it, then lets go of its tools servers; closing again waits for the first. */
  readonly close: () => Promise<void>;
}

interface BrainState {
  lifecycle: "open" | "stopping" | "closed";
  steps: number;
  sent: Record<string, string> | undefined;
  prefix: string;
  parts: PromptPart[];
  requestPrefix: string;
  requestTools: ToolDeclaration[];
  knownMemory: string[];
  toolList: readonly Tool[];
  core: Agent<Own> | undefined;
  todos: TodoRunner | undefined;
  folding: CompactionOptions;
}

export async function makeBrain(options: BrainOptions): Promise<Brain> {
  const log = options.log ?? consoleLog;
  const mcp = await connectAll(options.mcpServers ?? [], log);
  try {
    return await openBrain(options, mcp, log);
  } catch (e) {
    await mcp.close();
    throw e;
  }
}

async function openBrain(options: BrainOptions, mcp: Awaited<ReturnType<typeof connectAll>>, log: AgentLog): Promise<Brain> {
  const clock = options.clock ?? systemClock;
  const now = () => clock.now();
  const maxSteps = options.maxSteps ?? 40;
  const sessionName = options.session || options.name;
  const transcriptStore =
    options.noSession === true ? undefined : (options.transcript ?? fileTranscriptStore(join(options.home, sessionName + ".jsonl"), options.fs, log));
  const skillDirs = options.noSkills === true ? [] : (options.skills ?? defaultSkillDirs(options.cwd));
  const scanned = () => scanSkills(skillDirs, options.fs);

  const state: BrainState = {
    lifecycle: "open",
    steps: 0,
    sent: undefined,
    prefix: "",
    parts: [],
    requestPrefix: "",
    requestTools: [],
    knownMemory: [],
    toolList: [],
    core: undefined,
    todos: undefined,
    folding: {
      home: options.home,
      session: sessionName,
      llm: options.llm,
      budget: options.contextTokens ?? 120_000,
      keepRecent: options.keepRecent ?? 12,
      keepSaid: 3,
      now,
      log,
      ...(options.fs ? { fs: options.fs } : {}),
    },
  };

  const hub = new Hub<BrainEvent>();
  const publish = (e: BrainEvent) => hub.publish(e);
  const accounting = new RunAccounting();
  const tasks = new TaskGroup({ name: `agent ${options.name}`, onError: (task, e) => log.error(`agent ${options.name}: ${task} failed:`, e) });
  let waiters: PromiseWithResolvers<RunResult>[] = [];
  let folds = new Map<string, CompactionSummaryMessage>();
  const loop = () => {
    if (!state.core) throw new Error("the agent loop is not ready");
    return state.core;
  };

  const hostTools = [...(options.tools ?? []), ...mcp.tools];
  const memoryPort = options.noMemory === true ? undefined : (options.memory ?? fileMemory(options.home, now, options.fs, log));
  const own = selfTools({
    now,
    home: options.home,
    skills: scanned,
    memory: memoryPort ?? false,
    log,
    ...(options.fs ? { fs: options.fs } : {}),
  });
  const subagent: Subagent | undefined =
    options.noSubagents === true
      ? undefined
      : async (brief, label, signal) => {
          try {
            await using h = await makeBrain({
              name: options.name + words.subagentNameSuffix,
              instructions: subagentInstructions(options.name),
              llm: options.llm,
              ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
              home: options.home,
              cwd: options.cwd,
              ...(options.fs ? { fs: options.fs } : {}),
              clock,
              log,
              tools: hostTools,
              ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
              skills: skillDirs,
              noMemory: true,
              maxSteps: 30,
              noSession: true,
              noSubagents: true,
              reminders: false,
            });
            // Called back, it stops waiting; closing the subagent (await using) stops its run.
            const said = await abortable(h.ask(userMessage(brief, now())), signal);
            return said || words.subagentNoAnswer(label);
          } catch (e) {
            if (isAbort(e, signal)) throw e;
            throw toolFailed(e);
          }
        };
  if (subagent) own.push(subagentTool(subagent));
  const todoStore = options.todos ? watchedStore(options.todos, (g) => publish({ type: "todos_changed", todos: finished(g) ? [] : g })) : undefined;
  if (todoStore) {
    own.push(...todoTools(todoStore, subagent !== undefined, async () => state.todos?.advance()));
    // Preserve the active todo graph across compaction when earlier turns are summarized away.
    state.folding = { ...state.folding, append: async () => (await state.todos?.summary()) ?? "" };
  }

  const promptParts = async () => {
    const found = await scanned();
    const memory = memoryPort ? (await memoryPort.read()).prompt : "";
    const all: PromptPart[] = [
      { name: "instructions", text: options.instructions.trim() },
      { name: "env", text: words.envSection(options.cwd) },
    ];
    if (found.length > 0) all.push({ name: "skills", text: words.skillsSection(skillIndex(found)) });
    if (memory) all.push({ name: "memory", text: words.memorySection(memory) });
    return all.filter((p) => p.text !== "");
  };
  const memoryLines = async (): Promise<string[]> => (memoryPort ? [...(await memoryPort.read()).lines] : []);

  /** Rebuild system prefix only at startup and post-compaction so prompt cache stays warm mid-run. */
  const refreshPrefix = async () => {
    state.parts = await promptParts();
    state.prefix = joinParts(state.parts);
    state.knownMemory = await memoryLines();
    state.sent = undefined;
  };

  const noteChanges = (all: readonly PromptPart[], tools: readonly ToolDeclaration[]) => {
    const hashes = prefixHashes(all, tools);
    const changed = changedParts(state.sent, hashes);
    state.sent = hashes;
    if (changed.length > 0) publish({ type: "prefix_changed", parts: changed });
  };

  const save = async (message: BrainMessage) => {
    if (transcriptStore === undefined) return;
    try {
      await transcriptStore.append(message);
    } catch (err) {
      log.error(`agent ${options.name}: cannot save the conversation:`, err);
    }
  };

  /** Compacts using the prior request's prefix and tools so the summary call hits the prompt cache. */
  const fold = async (
    messages: readonly BrainMessage[],
    tools: readonly ToolDeclaration[],
    with_: CompactionOptions,
    reason: FoldReason,
    signal?: AbortSignal,
  ): Promise<Folded> => {
    const plan = planCompaction(messages, with_);
    if (!plan) return { fresh: false };
    const key = `${plan.cut}:${messages[plan.cut]?.timestamp ?? 0}`;
    const known = folds.get(key);
    if (known) return { result: applyPlan(plan, known), fresh: false };
    publish({ type: "compaction_start", reason });
    let summarized: Summarized;
    try {
      summarized = await compactInPlace(plan, with_, state.prefix, tools, signal);
    } catch (e) {
      if (isAbort(e, signal) || signal?.aborted === true) {
        publish({ type: "compaction_end", reason });
        throw e;
      }
      log.error(`agent ${options.name}: cannot fold the conversation:`, e);
      summarized = {};
    }
    const { summary, usage } = summarized;
    publish({ type: "compaction_end", reason, ...(summary ? { compaction: summary } : {}), ...(usage ? { usage } : {}) });
    if (!summary) return { fresh: false };
    folds = new Map(folds).set(key, summary);
    return { result: applyPlan(plan, summary), fresh: true };
  };

  const history = () => [...loop().messages()];
  const toolset = () => state.toolList;

  const settleFold = async () => {
    const { result, fresh } = await fold(history(), declared(toolset()), state.folding, "threshold");
    if (!result) return;
    if (fresh) await refreshPrefix();
    folds = new Map();
    loop().setMessages(result.messages);
    await save(result.summary);
  };

  const observeRun = (e: CoreEvent) => {
    switch (e.type) {
      case "agent_start":
        accounting.begin();
        break;
      case "message_start":
      case "message_update":
        if (e.message.role === "assistant") accounting.partial(e.message);
        break;
      case "message_end":
        if (e.message.role === "assistant") accounting.message(e.message);
        else if (e.message.role === "user" || e.message.role === "custom") accounting.heard();
        break;
      default:
        break;
    }
  };

  const quiet = async () => !accounting.active() && !(await loop().hasQueued());
  const idleAfter = () => options.idleFoldAfterMs ?? 10 * 60_000;
  const idleAt = () => options.idleFoldAt ?? Math.trunc((state.folding.budget * 4) / 5);
  const idleKey = "idle fold";
  const stopIdle = () => tasks.stop(idleKey);

  // A function, not a read: the lifecycle can close while a fold is out.
  const closed = () => state.lifecycle === "closed";
  const foldIdle = async () => {
    if (closed() || !(await quiet())) return;
    if (options.wakeSoon?.(idleAfter()) === true) return;
    const before = history();
    const { result } = await fold(before, declared(toolset()), { ...state.folding, budget: idleAt() }, "idle");
    if (!result) return;
    folds = new Map();
    // Drop the idle summary if new messages arrived while summarizing.
    if (closed() || !(await quiet()) || !sameMessages(history(), before)) return;
    loop().setMessages(result.messages);
    await save(result.summary);
    await refreshPrefix();
  };

  const idleLater = () => {
    const after = idleAfter();
    if (after < 0 || estimateTokens(history()) <= idleAt()) return;
    // The wait is the one stopIdle calls off; the fold, once it starts, goes on as the brain's own.
    tasks.keyed(idleKey, async (signal) => {
      await clock.sleep(after, signal);
      tasks.run("fold while idle", foldIdle);
    });
  };

  const continueRun = async (): Promise<void> => {
    state.steps = 0;
    // `stop` can drain the queue right after `hasQueued`; settle directly when nothing remains to continue.
    try {
      await loop().continue();
    } catch (err) {
      if (err instanceof CannotContinue) return ended();
      if (err instanceof AgentBusy) {
        log.warn(`agent ${options.name}: cannot continue run:`, err);
        return;
      }
      throw err;
    }
  };

  const ended = async (): Promise<void> => {
    const alive = () => state.lifecycle !== "closed";
    if (alive() && (await loop().hasQueued())) return continueRun();
    // Persist threshold compactions already used mid-run; otherwise defer compaction until idle.
    const folded = folds.size > 0;
    if (alive() && folded) await settleFold();
    if (alive() && (await loop().hasQueued())) return continueRun();
    if (!accounting.active()) return;
    const result = accounting.settle(state.lifecycle !== "open");
    if (state.lifecycle === "stopping") state.lifecycle = "open";
    if (alive() && !folded) idleLater();
    const settled = waiters;
    waiters = [];
    publish({ type: "agent_settled", run: result, progress: accounting.snapshot() });
    for (const w of settled) w.resolve(result);
    if (state.todos && !result.aborted && !result.failed && alive()) {
      const text = await state.todos.nudge();
      if (text) await later(taskMessage(text, now()));
    }
  };

  /** The loop's events, in order: each message saved before it is passed on; after a run's end, what follows it. */
  const follow = async (e: CoreEvent) => {
    observeRun(e);
    // Skip persisting partial/aborted messages during shutdown so the next startup can resume from the cut point.
    if (e.type === "message_end" && state.lifecycle !== "closed") await save(e.message);
    publish(e);
    if (e.type === "agent_end")
      tasks.run("settle", async () => {
        await loop().idle();
        await ended();
      });
  };

  const prepare = async (messages: readonly BrainMessage[], stoppedRun: boolean, signal: AbortSignal) => {
    const tools = declared(toolset());
    const { result, fresh }: Folded = stoppedRun ? { fresh: false } : await fold(messages, tools, state.folding, "threshold", signal);
    if (result && fresh) await refreshPrefix();
    state.requestPrefix = state.prefix;
    state.requestTools = tools;
    noteChanges(state.parts, tools);
    return result?.messages;
  };

  const deliver = async (message: BrainMessage, steer: boolean): Promise<void> => {
    if (state.lifecycle === "closed") return;
    if (accounting.active()) return steer ? loop().steer(message) : loop().followUp(message);
    // Begun at once: what comes before the run starts joins it.
    accounting.begin();
    state.steps = 0;
    await stopIdle();
    try {
      await loop().prompt([message]);
    } catch (err) {
      log.error(`agent ${options.name}: cannot start a run:`, err);
    }
  };
  const later = (message: BrainMessage) => deliver(message, false);

  await refreshPrefix();
  let tools = allowed([...hostTools, ...own], options.disallowedTools);
  let reminders: Awaited<ReturnType<typeof makeReminders>> | undefined;
  if (options.reminders ?? transcriptStore !== undefined) {
    reminders = await makeReminders(
      options.home,
      async (due) => {
        for (const text of due) await later(customMessage("reminder", text, now()));
      },
      { clock, log, ...(options.fs ? { fs: options.fs } : {}) },
    );
    tools = allowed([...tools, ...reminders.tools], options.disallowedTools);
  }
  if (todoStore)
    state.todos = makeTodoRunner(todoStore, subagent, (text) => later(taskMessage(text, now())), options.maxSubagents ?? 3, options.maxNudges ?? 3, log);
  state.toolList = tools;
  state.core = make<Own>({
    llm: options.llm.service,
    model: options.llm.model,
    thinkingLevel: options.thinkingLevel ?? "off",
    tools,
    messages: transcriptStore === undefined ? [] : await transcriptStore.load(),
    apiKey: () => options.llm.apiKey?.() ?? "",
    toLlm: (messages) => requestContext(state.requestPrefix, state.requestTools, messages),
    prepareRequest: prepare,
    finishTurn: (turn) => {
      state.steps++;
      return state.steps >= maxSteps || turn.stopped ? "end" : undefined;
    },
    onEvent: follow,
    stoppedText: stopped,
    clock,
  });
  const brainCore = state.core;

  // The run is stopped and settled while the loop, the background tasks and the tools servers are still there; then
  // each is let go of, the tools servers last.
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      state.lifecycle = "closed";
      await stopIdle();
      await brainCore.abort();
      await brainCore.idle();
      if (state.todos) await state.todos.close();
      // A queued continuation cancelled before it starts has no end event.
      await ended();
      publish({ type: "agent_closed" });
      hub.end();
      await brainCore.close();
      await reminders?.close();
      await tasks.close();
      await mcp.close();
    })());
  if (state.todos) {
    const runner = state.todos;
    tasks.run("recover", () => runner.recover());
  }

  return {
    send: (message) => deliver(message, true),
    later,
    ask: async (message, signal) => {
      if (state.lifecycle === "closed") throw new AgentClosed("the agent is closed");
      const answer = Promise.withResolvers<RunResult>();
      waiters = [...waiters, answer];
      try {
        await deliver(message, true);
        const r = await abortable(answer.promise, signal);
        return r.text;
      } finally {
        waiters = waiters.filter((w) => w !== answer);
      }
    },
    events: () => hub.subscribe(),
    busy: () => accounting.active(),
    progress: () => accounting.snapshot(),
    stop: async () => {
      if (state.todos) await state.todos.stop();
      await brainCore.clearQueues();
      if (accounting.active() && state.lifecycle === "open") state.lifecycle = "stopping";
      await brainCore.abort();
    },
    history,
    queued: () => brainCore.hasQueued(),
    tools: toolset,
    reset: async () => {
      await stopIdle();
      await brainCore.clearQueues();
      brainCore.setMessages([]);
      if (transcriptStore === undefined) return;
      try {
        await transcriptStore.clear();
      } catch (err) {
        log.error(`agent ${options.name}: cannot clear the conversation:`, err);
      }
    },
    skills: scanned,
    mcpStatus: () => ({ toolCount: mcp.tools.length, failed: [...mcp.failed] }),
    memoryNews: async () => {
      if (options.noMemory === true) return "";
      const current = await memoryLines();
      const before = state.knownMemory;
      state.knownMemory = current;
      const lines = [...current.filter((l) => !before.includes(l)).map((l) => "+ " + l), ...before.filter((l) => !current.includes(l)).map((l) => "− " + l)];
      return lines.length === 0 ? "" : words.memoryNews(lines.join("\n"));
    },
    resume: async (maxAgeMs) => {
      if (!(await quiet())) return false;
      const messages = history();
      const { missing, ok } = unfinished(messages);
      const last = messages.at(-1);
      const at = now();
      if (!ok || !last || at - last.timestamp > maxAgeMs) return false;
      if (missing.length > 0) {
        const more: BrainMessage[] = missing.map((call) => ({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: resumedUnknown }],
          isError: true,
          timestamp: at,
        }));
        for (const m of more) await save(m);
        brainCore.setMessages([...brainCore.messages(), ...more]);
      }
      await stopIdle();
      accounting.begin();
      await continueRun();
      return true;
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}
