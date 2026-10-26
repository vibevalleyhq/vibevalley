// VibeValley's own agent, on pi-agent-core's Agent. A message is saved before its message_end is passed on. Past its
// budget the older part of the conversation is folded into a summary: for a request as soon as it is too long, in the
// file once the run is over; past idleFoldAt, once it has been idle idleFoldAfterMs. The system prompt is made when the
// agent starts and after each fold, never per request: what changes meanwhile (the time, the host's situation, new
// memory) goes in the newest input, so the start of every request stays the cached one.

import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Tool, toToolDeclaration, type ToolCall, type Usage } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { finished, type AgentTask } from "./agentTask.ts";
import type { AgentTaskStore } from "./agentTaskStore.ts";
import { applyPlan, type Compacted, type CompactionOptions, compactInPlace, estimateTokens, planCompaction } from "./compaction.ts";
import type { LLM, McpServer } from "./config.ts";
import { connectAll, type McpConnections } from "./mcp.ts";
import { memoryFileLines, readMemory } from "./memory.ts";
import { type CompactionSummaryMessage, customMessage, kept, messageText, userMessage, withPrefix } from "./messages.ts";
import { changedParts, joinParts, prefixHashes, type PromptPart } from "./prefix.ts";
import { RunAccounting, type RunResult, type RunSnapshot } from "./run.ts";
import { Reminders } from "./reminders.ts";
import { type Subagent, selfTools, subagentInstructions, subagentTool } from "./self.ts";
import { SessionFile } from "./session.ts";
import { defaultSkillDirs, scanSkills, type SkillInfo, skillIndex } from "./skills.ts";
import { AgentTaskRunner, taskTools, watchedStore } from "./agentTaskTools.ts";
import { stopped } from "./tool.ts";
import type { CallbackLog } from "../../base/log.ts";
import type { Time } from "../../base/time.ts";

/** A pi-agent-core event, or one of this agent's own. */
export type BrainEvent =
  | AgentEvent
  | { readonly type: "agent_settled"; readonly run: RunResult }
  | { readonly type: "compaction_start"; readonly reason: FoldReason }
  /** compaction is absent when no summary was produced; usage is the summary request's, absent when none was made. */
  | {
      readonly type: "compaction_end";
      readonly reason: FoldReason;
      readonly compaction?: CompactionSummaryMessage;
      readonly usage?: Usage;
    }
  /** The parts of the prompt's start that changed since the request before, with no compaction between. */
  | { readonly type: "prefix_changed"; readonly parts: string[] }
  /** Its own tasks after a change, whoever made it; empty once finished. */
  | { readonly type: "tasks_changed"; readonly tasks: AgentTask[] };

export type FoldReason = "threshold" | "idle";

export interface BrainOptions {
  /** Also the session file's name unless session says otherwise. */
  readonly name: string;
  readonly instructions: string;
  readonly llm: LLM;
  readonly thinkingLevel?: ThinkingLevel;
  readonly home: string;
  readonly cwd: string;
  readonly tools?: readonly AgentTool[];
  /** Applied after all built-in, host and scheduled tools have been assembled. */
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: readonly McpServer[];
  /** Absent: the shared, Claude Code's and the work directory's. noSkills for none. */
  readonly skills?: readonly string[];
  readonly noSkills?: boolean;
  readonly noMemory?: boolean;
  /** 40 when absent. */
  readonly maxSteps?: number;
  /** Tokens (estimated) past which the older part is folded; 120 000 when absent. */
  readonly contextTokens?: number;
  /** 12 when absent. */
  readonly keepRecent?: number;
  /** Tokens (estimated) past which a conversation idle idleFoldAfterMs is folded; four fifths of contextTokens when absent. */
  readonly idleFoldAt?: number;
  /** 10 minutes when absent; below 0, never folded idle. */
  readonly idleFoldAfterMs?: number;
  /** Asked before an idle fold: true when the agent will be woken within that long anyway, and its first request folds if it must. */
  readonly wakeSoon?: (withinMs: number) => boolean;
  /** Absent: name. noSession keeps nothing on disk (a subagent). */
  readonly session?: string;
  readonly noSession?: boolean;
  /** A subagent never can. */
  readonly noSubagents?: boolean;
  /** Its own tasks and the tools to task and mark it; absent, none. */
  readonly tasks?: AgentTaskStore;
  /** Subagents out on its tasks at once; 3 when absent. */
  readonly maxSubagents?: number;
  /** Times a run that stops with its own tasks ready is reminded of them while the graph stays the same; 3 when absent. */
  readonly maxNudges?: number;
  /** Absent: when it keeps a session. */
  readonly reminders?: boolean;
  /** Default later. */
  readonly wake?: (text: string) => void;
  /** Its clock (base/time.ts): message times, the reminder ticks, the idle fold, a resumed run's age. A subagent it
   * sends out shares it. */
  readonly time: Time;
  /** Where what went wrong is written (base/log.ts): the service's logger, or plainLog on the command line. Shared with a
   * subagent too. */
  readonly log: CallbackLog;
}

export interface McpStatus {
  readonly toolCount: number;
  readonly failed: string[];
}

/** How often the reminders are looked at: a due one is woken within this. */
const reminderTickMs = 20_000;

export const resumedUnknown = "服务端在这个工具做完之前重启了，不知道它做没做成：先查一下现状，再决定要不要再做一遍。";

const taskMessage = (text: string, now: number) => customMessage("task", text, now);

const allowed = (tools: readonly AgentTool[], disallowed: readonly string[] = []) => tools.filter((t) => !disallowed.includes(t.name));

/** The calls of the last answer that have no result; ok is false when there is nothing to go on with: the model spoke
 * last with nothing left to do, or the run was stopped or failed. */
export function unfinished(messages: readonly AgentMessage[]): {
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
        const answer = messages[i]!;
        if (answer.role !== "assistant") continue;
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
    case "bashExecution":
    case "branchSummary":
    case "compactionSummary":
    case "system":
      break;
  }
  return { missing: [], ok: false };
}

/** Reads the file only, without making an agent. */
export const sessionUnfinished = (file: string) => unfinished(new SessionFile(file).load()).ok;

const sameMessages = (a: readonly AgentMessage[], b: readonly AgentMessage[]) =>
  a.length === b.length && (a.length === 0 || a.at(-1)!.timestamp === b.at(-1)!.timestamp);

export class Brain {
  readonly core: Agent;

  private readonly life = new AbortController();
  private readonly session: SessionFile | undefined;
  private readonly skillDirs: readonly string[];
  private readonly folding: CompactionOptions;
  private readonly listeners = new Set<(e: BrainEvent) => void>();
  private readonly accounting = new RunAccounting();
  private readonly maxSteps: number;
  private readonly tasks: AgentTaskRunner | undefined;
  private waiters: ((r: RunResult) => void)[] = [];
  private steps = 0;
  private stopping = false;
  private closing: Promise<void> | undefined;
  /** Made once per place. */
  private folds = new Map<string, CompactionSummaryMessage>();
  /** What the last request's prompt start hashed to, per part; absent before the first request and after a compaction. */
  private sent: Record<string, string> | undefined;
  /** The system prompt and its parts, as refreshPrefix made them. */
  private prefix = "";
  private parts: PromptPart[] = [];
  /** What the request under way starts with. */
  private requestPrefix = "";
  private requestTools: Tool[] = [];
  /** The lines of MEMORY.md the model knows: the snapshot's, then as memoryNews told it. */
  private knownMemory: string[] = [];
  /** What cancels the pending idle fold and the next reminder tick. */
  private idle: (() => void) | undefined;
  private scheduleTimer: (() => void) | undefined;

  /** Connects to its MCP servers first; one that cannot be reached is left out (mcpStatus). */
  static async start(options: BrainOptions, signal?: AbortSignal): Promise<Brain> {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const mcp = await connectAll(options.mcpServers ?? [], signal);
    if (signal?.aborted) {
      await mcp.close();
      throw signal.reason ?? new Error("aborted");
    }
    try {
      return new Brain(options, mcp);
    } catch (e) {
      await mcp.close();
      throw e;
    }
  }

  private constructor(
    private readonly options: BrainOptions,
    private readonly mcp: McpConnections,
  ) {
    this.maxSteps = options.maxSteps ?? 40;
    const sessionName = options.session || options.name;
    if (!options.noSession) this.session = new SessionFile(join(options.home, sessionName + ".jsonl"));
    this.skillDirs = options.noSkills ? [] : (options.skills ?? defaultSkillDirs(options.cwd));
    const budget = options.contextTokens ?? 120_000;
    this.folding = {
      home: options.home,
      session: sessionName,
      llm: options.llm,
      budget,
      keepRecent: options.keepRecent ?? 12,
      keepSaid: 3,
      now: () => options.time.now(),
    };

    const hostTools = [...(options.tools ?? []), ...this.mcp.tools];
    const own = selfTools({
      now: () => options.time.now(),
      home: options.home,
      skills: () => this.skills(),
      memory: !options.noMemory,
    });
    let subagent: Subagent | undefined;
    if (!options.noSubagents) {
      subagent = async (brief, label, signal) => {
        const h = await Brain.start(
          {
            name: options.name + "-帮手",
            instructions: subagentInstructions(options.name),
            llm: options.llm,
            ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
            home: options.home,
            cwd: options.cwd,
            tools: hostTools,
            ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
            skills: this.skillDirs,
            noMemory: true,
            maxSteps: 30,
            noSession: true,
            noSubagents: true,
            reminders: false,
            time: options.time,
            log: options.log,
          },
          signal,
        );
        try {
          const said = await h.ask(userMessage(brief, options.time.now()), AbortSignal.any([signal, this.life.signal]));
          return said || "帮手「" + label + "」没有交回结果。";
        } finally {
          await h.close();
        }
      };
      own.push(subagentTool(subagent));
    }
    if (options.tasks) {
      const store = watchedStore(options.tasks, (g) => this.publish({ type: "tasks_changed", tasks: finished(g) ? [] : g }));
      this.tasks = new AgentTaskRunner(
        store,
        subagent,
        this.life.signal,
        (text) => this.later(taskMessage(text, options.time.now())),
        options.log,
        options.maxSubagents ?? 3,
        options.maxNudges ?? 3,
      );
      const runner = this.tasks;
      own.push(...taskTools(store, subagent !== undefined, () => void runner.advance()));
      // A fold replaces the turns that showed the graph: the summary carries it on.
      this.folding = { ...this.folding, append: () => runner.summary() };
    }

    this.refreshPrefix();
    let tools = allowed([...hostTools, ...own], options.disallowedTools);
    const reminding = options.reminders ?? this.session !== undefined;
    let reminders: Reminders | undefined;
    if (reminding) {
      reminders = new Reminders(
        options.home,
        options.wake ?? ((text) => this.later(customMessage("reminder", text, options.time.now()))),
        options.time,
        options.log,
      );
      tools = allowed([...tools, ...reminders.tools], options.disallowedTools);
    }
    this.core = new Agent({
      initialState: {
        model: options.llm.model,
        thinkingLevel: options.thinkingLevel ?? "off",
        tools,
        messages: this.session?.load() ?? [],
      },
      streamFn: options.llm.stream,
      getApiKey: () => options.llm.apiKey?.(),
      convertToLlm: (messages) => withPrefix(this.requestPrefix, this.requestTools, messages),
      // The fold before the prompt: a fold makes the prompt anew, and this request is the first to start with it.
      prepareRequest: async ({ context }, signal) => {
        const tools = (context.tools ?? []).map(toToolDeclaration);
        const { result, fresh } = await this.fold(kept(context.messages), tools, this.folding, "threshold", signal);
        if (result && fresh) this.refreshPrefix();
        this.requestPrefix = this.prefix;
        this.requestTools = tools;
        this.noteChanges(this.parts, tools);
        return result ? { context: { ...context, messages: result.messages } } : undefined;
      },
      // A stop that came while the tools ran ends the run with their results, as the model's answer would.
      finishTurn: (_turn, signal) => {
        this.steps++;
        return this.steps >= this.maxSteps || signal?.aborted ? { action: "end" } : undefined;
      },
    });

    // The core's events, in order: each message saved before it is passed on; after a run's end, what follows it.
    this.core.subscribe((e) => {
      if ((e.type === "message_start" || e.type === "message_end" || e.type === "message_update") && e.message.role === "system") return;
      this.observeRun(e);
      // Not what closing it made (the answer cut off, its tools' "stopped"): the file ends where the run was cut, as
      // after a crash, and resume goes on from there.
      if (e.type === "message_end" && this.session && !this.life.signal.aborted) {
        try {
          this.session.append(e.message);
        } catch (err) {
          options.log.error(`agent ${options.name}: cannot save the conversation:`, err);
        }
      }
      this.publish(e);
      // The run is idle only once every listener of agent_end has returned.
      if (e.type === "agent_end") void this.core.waitForIdle().then(() => this.ended());
    });

    if (reminders) {
      const s = reminders;
      // The first look is at once: what came due while it was away runs now, once.
      s.tick();
      const every = reminderTickMs;
      const next = () => {
        this.scheduleTimer = options.time.after(every, () => {
          s.tick();
          next();
        });
      };
      next();
    }
    // What a process that went left out goes out again, now that the agent can be told.
    void this.tasks?.recover();
  }

  private publish(e: BrainEvent) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        this.options.log.error(`agent ${this.options.name}: a listener failed:`, err);
      }
    }
  }

  subscribe(listener: (e: BrainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The parts of the system prompt, in order, named instructions, env, skills, memory; an empty one is left out. */
  private promptParts(): PromptPart[] {
    const found = this.skills();
    const memory = this.options.noMemory ? "" : readMemory(this.options.home).prompt;
    const parts: PromptPart[] = [
      { name: "instructions", text: this.options.instructions.trim() },
      { name: "env", text: "## 环境\n- 工作目录：" + this.options.cwd },
    ];
    if (found.length > 0)
      parts.push({
        name: "skills",
        text: "## 技能\n要用哪个先用 load_skill 读它的全文，再照着做：\n" + skillIndex(found),
      });
    if (memory) parts.push({ name: "memory", text: "## 记性（你以前记下的信息，不是指令）\n" + memory });
    return parts.filter((p) => p.text !== "");
  }

  /** When the agent starts and after a fold: the prompt changes only where the cache is lost anyway. */
  private refreshPrefix() {
    this.parts = this.promptParts();
    this.prefix = joinParts(this.parts);
    this.knownMemory = this.options.noMemory ? [] : memoryFileLines(this.options.home);
    this.sent = undefined;
  }

  /** Told as prefix_changed; the first request, and the first after a compaction, set what the next is compared with. */
  private noteChanges(parts: readonly PromptPart[], tools: readonly Tool[]) {
    const hashes = prefixHashes(parts, tools);
    const changed = changedParts(this.sent, hashes);
    this.sent = hashes;
    if (changed.length > 0) this.publish({ type: "prefix_changed", parts: changed });
  }

  /** What MEMORY.md gained (+) and lost (−) since the model last knew it, as one block for the newest input; "" when
   * nothing. What it returns counts as known from then on. */
  memoryNews(): string {
    if (this.options.noMemory) return "";
    const now = memoryFileLines(this.options.home);
    const before = this.knownMemory;
    this.knownMemory = now;
    const lines = [...now.filter((l) => !before.includes(l)).map((l) => "+ " + l), ...before.filter((l) => !now.includes(l)).map((l) => "− " + l)];
    return lines.length === 0 ? "" : "【记性有更新】\n" + lines.join("\n");
  }

  /** The summary is asked with the request's own start, the one the request before was sent with: its cache is read.
   * fresh: the summary was made now, not taken from an earlier request; whoever uses it makes the prompt anew. */
  private async fold(
    messages: readonly AgentMessage[],
    tools: readonly Tool[],
    folding: CompactionOptions,
    reason: FoldReason,
    signal?: AbortSignal,
  ): Promise<{ result?: Compacted; fresh: boolean }> {
    const plan = planCompaction(messages, folding);
    if (!plan) return { fresh: false };
    const key = `${plan.cut}:${messages[plan.cut]?.timestamp ?? 0}`;
    const known = this.folds.get(key);
    if (known) return { result: applyPlan(plan, known), fresh: false };
    this.publish({ type: "compaction_start", reason });
    let summary: CompactionSummaryMessage | undefined;
    let usage: Usage | undefined;
    try {
      ({ summary, usage } = await compactInPlace(plan, folding, this.prefix, tools, signal));
    } catch (err) {
      this.options.log.error(`agent ${this.options.name}: cannot fold the conversation:`, err);
    }
    this.publish({
      type: "compaction_end",
      reason,
      ...(summary ? { compaction: summary } : {}),
      ...(usage ? { usage } : {}),
    });
    if (!summary) return { fresh: false };
    this.folds.set(key, summary);
    return { result: applyPlan(plan, summary), fresh: true };
  }

  /** A run that folded for a request keeps the fold: the summary it was answered with is saved. */
  private async settleFold() {
    const { result, fresh } = await this.fold(this.history(), this.core.state.tools.map(toToolDeclaration), this.folding, "threshold");
    if (!result) return;
    if (fresh) this.refreshPrefix();
    this.folds = new Map();
    this.core.state.messages = result.messages;
    this.save(result.summary);
  }

  private save(message: AgentMessage) {
    try {
      this.session?.append(message);
    } catch (err) {
      this.options.log.error(`agent ${this.options.name}: cannot save the conversation:`, err);
    }
  }

  private observeRun(e: AgentEvent) {
    switch (e.type) {
      case "agent_start":
        this.accounting.begin();
        break;
      case "message_start":
      case "message_update":
        if (e.message.role === "assistant") this.accounting.partial(e.message);
        break;
      case "message_end":
        if (e.message.role === "assistant") this.accounting.message(e.message);
        else if (e.message.role === "user" || e.message.role === "custom") this.accounting.heard();
        break;
      default:
        break;
    }
  }

  private continueRun() {
    this.steps = 0;
    // Stop can clear the queue after its check: then no core run starts, and no end event will follow.
    this.core.continue().catch(() => this.ended());
  }

  private async ended() {
    const alive = () => !this.life.signal.aborted;
    if (alive() && this.core.hasQueuedMessages()) return this.continueRun();
    // Only a fold a request already used is saved now; otherwise the conversation stays as it was until it is idle.
    const folded = this.folds.size > 0;
    if (alive() && folded) await this.settleFold();
    // Admission stays attached to this logical run until compaction and all queued input are settled.
    if (alive() && this.core.hasQueuedMessages()) return this.continueRun();
    if (!this.accounting.active()) return;
    const result = this.accounting.settle(this.stopping || !alive());
    this.stopping = false;
    if (alive() && !folded) this.idleLater();
    const waiters = this.waiters;
    this.waiters = [];
    this.publish({ type: "agent_settled", run: result });
    for (const w of waiters) w(result);
    if (this.tasks && !result.aborted && !result.error && alive()) {
      const text = await this.tasks.nudge();
      if (text) this.later(taskMessage(text, this.options.time.now()));
    }
  }

  private deliver(message: AgentMessage, steer: boolean) {
    if (this.life.signal.aborted) return;
    if (this.accounting.active()) {
      if (steer) this.core.steer(message);
      else this.core.followUp(message);
      return;
    }
    this.stopIdle();
    this.accounting.begin();
    this.steps = 0;
    this.core.prompt(message).catch((err) => this.options.log.error(`agent ${this.options.name}: cannot start a run:`, err));
  }

  /** Starts a run when idle, steers the one under way otherwise. */
  send(message: AgentMessage) {
    this.deliver(message, true);
  }

  /** Taken when the run would stop (a follow-up); starts a run when idle. */
  later(message: AgentMessage) {
    this.deliver(message, false);
  }

  /** What the run it starts or joins ends up saying. */
  ask(message: AgentMessage, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.life.signal.aborted) return reject(new Error("the agent is closed"));
      if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
      let settled = false;
      const waiter = (r: RunResult) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        resolve(r.text);
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        this.waiters = this.waiters.filter((w) => w !== waiter);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
      this.deliver(message, true);
    });
  }

  busy() {
    return this.accounting.active();
  }

  progress(): RunSnapshot {
    return this.accounting.snapshot();
  }

  /** Stops the run under way and calls back the subagents out on its tasks. */
  async stop() {
    await this.tasks?.stop();
    this.core.clearAllQueues();
    if (this.accounting.active()) this.stopping = true;
    this.core.abort();
  }

  history(): AgentMessage[] {
    return kept(this.core.state.messages);
  }

  /** The memory stays. */
  reset() {
    this.stopIdle();
    this.core.reset();
    this.session?.clear();
  }

  skills(): SkillInfo[] {
    return scanSkills(this.skillDirs);
  }

  mcpStatus(): McpStatus {
    return { toolCount: this.mcp.tools.length, failed: [...this.mcp.failed] };
  }

  /** Goes on with the run the conversation was cut off in; true when it does. Each call of the last answer without a
   * result is given one, failed, saying it is not known whether it was done. Not when it is busy, the run ended or was
   * stopped, or its last message is older than maxAgeMs. */
  resume(maxAgeMs: number): boolean {
    if (!this.quiet()) return false;
    const messages = this.history();
    const { missing, ok } = unfinished(messages);
    if (!ok || this.options.time.now() - messages.at(-1)!.timestamp > maxAgeMs) return false;
    if (missing.length > 0) {
      const more: AgentMessage[] = missing.map((call) => ({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: resumedUnknown }],
        isError: true,
        timestamp: this.options.time.now(),
      }));
      for (const m of more) this.save(m);
      this.core.state.messages = [...this.core.state.messages, ...more];
    }
    this.stopIdle();
    this.accounting.begin();
    this.continueRun();
    return true;
  }

  private quiet() {
    return !this.accounting.active() && !this.core.hasQueuedMessages();
  }

  private idleAfter() {
    return this.options.idleFoldAfterMs ?? 10 * 60_000;
  }

  private idleAt() {
    return this.options.idleFoldAt ?? Math.trunc((this.folding.budget * 4) / 5);
  }

  private stopIdle() {
    this.idle?.();
    this.idle = undefined;
  }

  // Folding when the run ends would give the owner a lossy summary a minute later; folding when they have gone keeps
  // the conversation as it was while they are likely to go on with it.
  private idleLater() {
    const after = this.idleAfter();
    if (after < 0 || estimateTokens(this.history()) <= this.idleAt()) return;
    this.stopIdle();
    this.idle = this.options.time.after(after, () => void this.foldIdle());
  }

  private async foldIdle() {
    this.idle = undefined;
    if (this.life.signal.aborted || !this.quiet()) return;
    if (this.options.wakeSoon?.(this.idleAfter())) return;
    const before = this.history();
    const { result } = await this.fold(
      before,
      this.core.state.tools.map(toToolDeclaration),
      { ...this.folding, budget: this.idleAt() },
      "idle",
      this.life.signal,
    );
    if (!result) return;
    this.folds = new Map();
    // What came in while the summary was being made is not lost: the fold is dropped, and done again when it is idle next.
    if (this.life.signal.aborted || !this.quiet() || !sameMessages(this.history(), before)) return;
    this.core.state.messages = result.messages;
    this.save(result.summary);
    this.refreshPrefix();
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.life.abort();
      this.closing = Promise.resolve().then(() => this.closeOnce());
    }
    return this.closing;
  }

  private async closeOnce() {
    this.stopIdle();
    this.scheduleTimer?.();
    this.life.abort();
    this.core.abort();
    await this.core.waitForIdle();
    await this.tasks?.settled();
    await this.mcp.close();
    // A queued continuation cancelled before it starts has no core end event.
    await this.ended();
    this.listeners.clear();
  }
}
