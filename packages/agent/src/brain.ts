// VibeValley's own agent, on the farm's loop (agent/loop). A message is saved before its message_end is passed on. Past its
// budget the older part of the conversation is folded into a summary: for a request as soon as it is too long, in the
// file once the run is over; past idleFoldAt, once it has been idle idleFoldAfterMs. The system prompt is made when the
// agent starts and after each fold, never per request: what changes meanwhile (the time, the host's situation, new
// memory) goes in the newest input, so the start of every request stays the cached one.

import { AgentClosed, type AgentFailed, agentFailed, toolFailed } from "./core/errors.ts";
import { Clock, Deferred, Effect, Exit, FiberHandle, FiberSet, Ref, Schedule, Scope } from "effect";
import { join } from "node:path";
import type { ToolCall, ToolDeclaration, Usage } from "@vibevalley/ai/messages";
import type { ThinkingLevel } from "@vibevalley/ai/models";
import { type Agent, type AgentEvent, make, type Tool } from "./core/loop.ts";
import { finished, type AgentTask } from "./agentTask.ts";
import type { AgentTaskStore } from "./agentTaskStore.ts";
import { applyPlan, type Compacted, type CompactionOptions, compactInPlace, estimateTokens, planCompaction, type Summarized } from "./compaction.ts";
import type { ModelClient } from "@vibevalley/ai/client";
import { type McpServer, connectAll, type McpConnections } from "./mcp.ts";
import { memoryFileLines, readMemory } from "./memory.ts";
import { type BrainMessage, type CompactionSummaryMessage, type CustomMessage, customMessage, messageText, requestContext, userMessage } from "./messages.ts";
import { changedParts, joinParts, prefixHashes, type PromptPart } from "./prefix.ts";
import { RunAccounting, type RunResult, type RunSnapshot } from "./run.ts";
import { Reminders } from "./reminders.ts";
import { type Subagent, selfTools, subagentInstructions, subagentTool } from "./self.ts";
import { SessionFile } from "./session.ts";
import { defaultSkillDirs, scanSkills, type SkillInfo, skillIndex } from "./skills.ts";
import { type AgentTaskRunner, makeTaskRunner, taskTools, watchedStore } from "./agentTaskTools.ts";
import { stopped } from "./core/tool.ts";
import { agent as words } from "./prompts.ts";

type Own = CustomMessage | CompactionSummaryMessage;

export type CoreEvent = AgentEvent<Own>;

export type BrainEvent =
  | CoreEvent
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

/** Run in order with the events: the brain goes on once it is done. */
export type Listener = (e: BrainEvent) => Effect.Effect<void>;

export type FoldReason = "threshold" | "idle";

export interface BrainOptions {
  /** Also the session file's name unless session says otherwise. */
  readonly name: string;
  readonly instructions: string;
  readonly llm: ModelClient;
  readonly thinkingLevel?: ThinkingLevel;
  readonly home: string;
  readonly cwd: string;
  readonly tools?: readonly Tool[];
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
}

export interface McpStatus {
  readonly toolCount: number;
  readonly failed: string[];
}

/** How often the reminders are looked at: a due one is woken within this. */
const reminderTickMs = 20_000;

export const resumedUnknown = words.resumedUnknown;

const taskMessage = (text: string, now: number) => customMessage("task", text, now);

const allowed = (tools: readonly Tool[], disallowed: readonly string[] = []) => tools.filter((t) => !disallowed.includes(t.name));

const declared = (tools: readonly Tool[]): ToolDeclaration[] => tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

interface Folded {
  readonly result?: Compacted;
  readonly fresh: boolean;
}

/** The calls of the last answer that have no result; ok is false when there is nothing to go on with: the model spoke
 * last with nothing left to do, or the run was stopped or failed. */
export function unfinished(messages: readonly BrainMessage[]): {
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
    case "compactionSummary":
      return { missing: [], ok: false };
  }
}

/** Reads the file only, without making an agent. */
export const sessionUnfinished = (file: string) => unfinished(new SessionFile(file).load()).ok;

const sameMessages = (a: readonly BrainMessage[], b: readonly BrainMessage[]) => a.length === b.length && a.at(-1)?.timestamp === b.at(-1)?.timestamp;

export class Brain {
  // Set in make, before anything can call the brain.
  private core!: Agent<Own>;
  /** What follows a run, an idle fold under way, the first look at its tasks: fibers of the brain's scope. */
  private fibers!: FiberSet.FiberSet;
  private idleFold!: FiberHandle.FiberHandle;
  private tasks: AgentTaskRunner | undefined;

  private readonly session: SessionFile | undefined;
  private readonly skillDirs: readonly string[];
  private readonly folding: CompactionOptions;
  private readonly toolset: readonly Tool[];
  private readonly taskStore: AgentTaskStore | undefined;
  private readonly subagent: Subagent | undefined;
  private readonly reminders: Reminders | undefined;
  private readonly listeners = new Set<Listener>();
  private readonly accounting = new RunAccounting();
  private readonly maxSteps: number;
  private waiters: Deferred.Deferred<RunResult>[] = [];
  private steps = 0;
  private stopping = false;
  private closed = false;
  /** Made once per place. */
  private folds = new Map<string, CompactionSummaryMessage>();
  /** What the last request's prompt start hashed to, per part; absent before the first request and after a compaction. */
  private sent: Record<string, string> | undefined;
  /** The system prompt and its parts, as refreshPrefix made them. */
  private prefix = "";
  private parts: PromptPart[] = [];
  /** What the request under way starts with. */
  private requestPrefix = "";
  private requestTools: ToolDeclaration[] = [];
  /** The lines of MEMORY.md the model knows: the snapshot's, then as memoryNews told it. */
  private knownMemory: string[] = [];

  /** Connects to its MCP servers first: one that cannot be reached is left out (mcpStatus). */
  static make(options: BrainOptions): Effect.Effect<Brain, AgentFailed, Scope.Scope> {
    return Effect.gen(function* () {
      const mcp = yield* Effect.acquireRelease(Effect.tryPromise({ try: (signal) => connectAll(options.mcpServers ?? [], signal), catch: agentFailed }), (m) =>
        Effect.promise(() => m.close()),
      );
      const clock = yield* Clock.Clock;
      const brain = yield* Effect.try({ try: () => new Brain(options, mcp, () => clock.currentTimeMillisUnsafe()), catch: agentFailed });
      yield* brain.open();
      return brain;
    });
  }

  private readonly options: BrainOptions;
  private readonly mcp: McpConnections;
  /** The Clock of the scope it was made in. */
  private readonly now: () => number;
  private constructor(options: BrainOptions, mcp: McpConnections, now: () => number) {
    this.options = options;
    this.mcp = mcp;
    this.now = now;
    this.maxSteps = options.maxSteps ?? 40;
    const sessionName = options.session || options.name;
    if (options.noSession !== true) this.session = new SessionFile(join(options.home, sessionName + ".jsonl"));
    this.skillDirs = options.noSkills === true ? [] : (options.skills ?? defaultSkillDirs(options.cwd));
    const budget = options.contextTokens ?? 120_000;
    this.folding = {
      home: options.home,
      session: sessionName,
      llm: options.llm,
      budget,
      keepRecent: options.keepRecent ?? 12,
      keepSaid: 3,
      now,
    };

    const hostTools = [...(options.tools ?? []), ...this.mcp.tools];
    const own = selfTools({ now, home: options.home, skills: () => this.skills(), memory: options.noMemory !== true });
    if (options.noSubagents !== true) {
      const skills = this.skillDirs;
      this.subagent = (brief, label) =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* Brain.make({
              name: options.name + words.subagentNameSuffix,
              instructions: subagentInstructions(options.name),
              llm: options.llm,
              ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
              home: options.home,
              cwd: options.cwd,
              tools: hostTools,
              ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
              skills,
              noMemory: true,
              maxSteps: 30,
              noSession: true,
              noSubagents: true,
              reminders: false,
            });
            const said = yield* h.ask(userMessage(brief, now()));
            return said || words.subagentNoAnswer(label);
          }),
        ).pipe(Effect.mapError(toolFailed));
      own.push(subagentTool(this.subagent));
    }
    if (options.tasks) {
      const store = watchedStore(options.tasks, (g) => this.publish({ type: "tasks_changed", tasks: finished(g) ? [] : g }));
      this.taskStore = store;
      own.push(
        ...taskTools(
          store,
          this.subagent !== undefined,
          Effect.suspend(() => this.tasks?.advance ?? Effect.void),
        ),
      );
      // A fold replaces the turns that showed the graph: the summary carries it on.
      this.folding = { ...this.folding, append: () => Effect.suspend(() => this.tasks?.summary ?? Effect.succeed("")) };
    }

    this.refreshPrefix();
    let tools = allowed([...hostTools, ...own], options.disallowedTools);
    if (options.reminders ?? this.session !== undefined) {
      this.reminders = new Reminders(options.home, now);
      tools = allowed([...tools, ...this.reminders.tools], options.disallowedTools);
    }
    this.toolset = tools;
  }

  private open(): Effect.Effect<void, never, Scope.Scope> {
    const self = this;
    const options = this.options;
    return Effect.gen(function* () {
      self.fibers = yield* FiberSet.make();
      self.idleFold = yield* FiberHandle.make();
      if (self.taskStore)
        self.tasks = yield* makeTaskRunner(
          self.taskStore,
          self.subagent,
          (text) => self.later(taskMessage(text, self.now())),
          options.maxSubagents ?? 3,
          options.maxNudges ?? 3,
        );
      self.core = yield* make<Own>({
        llm: options.llm.service,
        model: options.llm.model,
        thinkingLevel: options.thinkingLevel ?? "off",
        tools: self.toolset,
        messages: self.session?.load() ?? [],
        apiKey: () => options.llm.apiKey?.() ?? "",
        toLlm: (messages) => requestContext(self.requestPrefix, self.requestTools, messages),
        prepareRequest: (messages, stopped) => self.prepare(messages, stopped),
        // A stop that came while the tools ran ends the run with their results, as the model's answer would.
        finishTurn: (turn) =>
          Effect.sync(() => {
            self.steps++;
            return self.steps >= self.maxSteps || turn.stopped ? "end" : undefined;
          }),
        onEvent: (e) => self.follow(e),
        stoppedText: stopped,
      });
      // Finalizers run last in, first out: the brain closes while its loop, fibers and subagents are still there.
      yield* Effect.addFinalizer(() => self.closeOnce());
      // The first look is at once: what came due while it was away runs now, once.
      if (self.reminders) yield* Effect.forkScoped(Effect.repeat(self.tick(), Schedule.spaced(reminderTickMs)));
      // What a process that went left out goes out again, now that the agent can be told.
      if (self.tasks) yield* FiberSet.run(self.fibers, self.tasks.recover);
    });
  }

  private tick(): Effect.Effect<void> {
    return Effect.try({ try: () => this.reminders?.tick() ?? [], catch: agentFailed }).pipe(
      Effect.flatMap((due) => Effect.forEach(due, (text) => this.later(customMessage("reminder", text, this.now())), { discard: true })),
      Effect.catch((e) => Effect.logError("agent: cannot claim due reminders:", e)),
    );
  }

  /** The loop's events, in order: each message saved before it is passed on; after a run's end, what follows it. */
  private follow(e: CoreEvent): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      self.observeRun(e);
      // Not what closing it made (the answer cut off, its tools' "stopped"): the file ends where the run was cut, as
      // after a crash, and resume goes on from there.
      if (e.type === "message_end" && !self.closed) yield* self.save(e.message);
      yield* self.publish(e);
      // The run is idle once its fiber has ended, after this event.
      if (e.type === "agent_end") yield* FiberSet.run(self.fibers, Effect.andThen(self.core.idle, self.ended()));
    });
  }

  /** The fold before the prompt: a fold makes the prompt anew, and this request is the first to start with it. A stopped
   * run asks for no summary: its request ends at once. */
  private prepare(messages: readonly BrainMessage[], stoppedRun: boolean): Effect.Effect<readonly BrainMessage[] | undefined> {
    const self = this;
    return Effect.gen(function* () {
      const tools = declared(self.toolset);
      const { result, fresh }: Folded = stoppedRun ? { fresh: false } : yield* self.fold(messages, tools, self.folding, "threshold");
      if (result && fresh) self.refreshPrefix();
      self.requestPrefix = self.prefix;
      self.requestTools = tools;
      yield* self.noteChanges(self.parts, tools);
      return result?.messages;
    });
  }

  private publish(e: BrainEvent): Effect.Effect<void> {
    return Effect.forEach(
      [...this.listeners],
      (l) =>
        Effect.catchDefect(
          Effect.suspend(() => l(e)),
          (err) => Effect.logError(`agent ${this.options.name}: a listener failed:`, err),
        ),
      { discard: true },
    );
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The parts of the system prompt, in order, named instructions, env, skills, memory; an empty one is left out. */
  private promptParts(): PromptPart[] {
    const found = this.skills();
    const memory = this.options.noMemory === true ? "" : readMemory(this.options.home).prompt;
    const parts: PromptPart[] = [
      { name: "instructions", text: this.options.instructions.trim() },
      { name: "env", text: words.envSection(this.options.cwd) },
    ];
    if (found.length > 0)
      parts.push({
        name: "skills",
        text: words.skillsSection(skillIndex(found)),
      });
    if (memory) parts.push({ name: "memory", text: words.memorySection(memory) });
    return parts.filter((p) => p.text !== "");
  }

  /** When the agent starts and after a fold: the prompt changes only where the cache is lost anyway. */
  private refreshPrefix() {
    this.parts = this.promptParts();
    this.prefix = joinParts(this.parts);
    this.knownMemory = this.options.noMemory === true ? [] : memoryFileLines(this.options.home);
    this.sent = undefined;
  }

  /** Told as prefix_changed; the first request, and the first after a compaction, set what the next is compared with. */
  private noteChanges(parts: readonly PromptPart[], tools: readonly ToolDeclaration[]): Effect.Effect<void> {
    const hashes = prefixHashes(parts, tools);
    const changed = changedParts(this.sent, hashes);
    this.sent = hashes;
    return changed.length > 0 ? this.publish({ type: "prefix_changed", parts: changed }) : Effect.void;
  }

  /** What MEMORY.md gained (+) and lost (−) since the model last knew it, as one block for the newest input; "" when
   * nothing. What it returns counts as known from then on. */
  memoryNews(): string {
    if (this.options.noMemory === true) return "";
    const now = memoryFileLines(this.options.home);
    const before = this.knownMemory;
    this.knownMemory = now;
    const lines = [...now.filter((l) => !before.includes(l)).map((l) => "+ " + l), ...before.filter((l) => !now.includes(l)).map((l) => "− " + l)];
    return lines.length === 0 ? "" : words.memoryNews(lines.join("\n"));
  }

  /** The summary is asked with the request's own start, the one the request before was sent with: its cache is read.
   * fresh: the summary was made now, not taken from an earlier request; whoever uses it makes the prompt anew.
   * Interrupted, it ends with no summary. */
  private fold(messages: readonly BrainMessage[], tools: readonly ToolDeclaration[], folding: CompactionOptions, reason: FoldReason): Effect.Effect<Folded> {
    const self = this;
    return Effect.gen(function* () {
      const plan = planCompaction(messages, folding);
      if (!plan) return { fresh: false };
      const key = `${plan.cut}:${messages[plan.cut]?.timestamp ?? 0}`;
      const known = self.folds.get(key);
      if (known) return { result: applyPlan(plan, known), fresh: false };
      yield* self.publish({ type: "compaction_start", reason });
      const { summary, usage } = yield* compactInPlace(plan, folding, self.prefix, tools).pipe(
        Effect.catchDefect((err) => Effect.as(Effect.logError(`agent ${self.options.name}: cannot fold the conversation:`, err), {} as Summarized)),
        Effect.onInterrupt(() => self.publish({ type: "compaction_end", reason })),
      );
      yield* self.publish({
        type: "compaction_end",
        reason,
        ...(summary ? { compaction: summary } : {}),
        ...(usage ? { usage } : {}),
      });
      if (!summary) return { fresh: false };
      self.folds.set(key, summary);
      return { result: applyPlan(plan, summary), fresh: true };
    });
  }

  /** A run that folded for a request keeps the fold: the summary it was answered with is saved. */
  private settleFold(): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const { result, fresh } = yield* self.fold(self.history(), declared(self.toolset), self.folding, "threshold");
      if (!result) return;
      if (fresh) self.refreshPrefix();
      self.folds = new Map();
      yield* Ref.set(self.core.messages, result.messages);
      yield* self.save(result.summary);
    });
  }

  private save(message: BrainMessage): Effect.Effect<void> {
    return Effect.try({ try: () => this.session?.append(message), catch: agentFailed }).pipe(
      Effect.catch((err) => Effect.logError(`agent ${this.options.name}: cannot save the conversation:`, err)),
    );
  }

  private observeRun(e: CoreEvent) {
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

  private continueRun(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.steps = 0;
      // Stop can clear the queue after its check: then no run starts, and no end event will follow.
      return Effect.catch(this.core.continue, () => this.ended());
    });
  }

  private ended(): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const alive = () => !self.closed;
      if (alive() && (yield* self.core.hasQueued)) return yield* self.continueRun();
      // Only a fold a request already used is saved now; otherwise the conversation stays as it was until it is idle.
      const folded = self.folds.size > 0;
      if (alive() && folded) yield* self.settleFold();
      // Admission stays attached to this logical run until compaction and all queued input are settled.
      if (alive() && (yield* self.core.hasQueued)) return yield* self.continueRun();
      if (!self.accounting.active()) return;
      const result = self.accounting.settle(self.stopping || !alive());
      self.stopping = false;
      if (alive() && !folded) yield* self.idleLater();
      const waiters = self.waiters;
      self.waiters = [];
      yield* self.publish({ type: "agent_settled", run: result });
      for (const w of waiters) yield* Deferred.succeed(w, result);
      if (self.tasks && !result.aborted && !result.failed && alive()) {
        const text = yield* self.tasks.nudge;
        if (text) yield* self.later(taskMessage(text, self.now()));
      }
    });
  }

  private deliver(message: BrainMessage, steer: boolean): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.void;
      if (this.accounting.active()) return steer ? this.core.steer(message) : this.core.followUp(message);
      // Begun at once: what comes before the run starts joins it.
      this.accounting.begin();
      this.steps = 0;
      return Effect.andThen(
        this.stopIdle(),
        Effect.catch(this.core.prompt([message]), (err) => Effect.logError(`agent ${this.options.name}: cannot start a run:`, err)),
      );
    });
  }

  /** Starts a run when idle, steers the one under way otherwise. */
  send(message: BrainMessage): Effect.Effect<void> {
    return this.deliver(message, true);
  }

  /** Taken when the run would stop (a follow-up); starts a run when idle. */
  later(message: BrainMessage): Effect.Effect<void> {
    return this.deliver(message, false);
  }

  /** What the run it starts or joins ends up saying. */
  ask(message: BrainMessage): Effect.Effect<string, AgentClosed> {
    const self = this;
    return Effect.gen(function* () {
      if (self.closed) return yield* new AgentClosed({ message: "the agent is closed" });
      const answer = yield* Deferred.make<RunResult>();
      self.waiters.push(answer);
      yield* self.deliver(message, true);
      const r = yield* Effect.ensuring(
        Deferred.await(answer),
        Effect.sync(() => {
          self.waiters = self.waiters.filter((w) => w !== answer);
        }),
      );
      return r.text;
    });
  }

  busy() {
    return this.accounting.active();
  }

  progress(): RunSnapshot {
    return this.accounting.snapshot();
  }

  /** Stops the run under way and calls back the subagents out on its tasks. */
  stop(): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      if (self.tasks) yield* self.tasks.stop;
      yield* self.core.clearQueues;
      if (self.accounting.active()) self.stopping = true;
      yield* self.core.abort;
    });
  }

  /** As it is now. */
  history(): BrainMessage[] {
    return [...Ref.getUnsafe(this.core.messages)];
  }

  /** Lines sent while it works that no turn has taken yet. */
  queued(): Effect.Effect<boolean> {
    return this.core.hasQueued;
  }

  tools(): readonly Tool[] {
    return this.toolset;
  }

  /** The memory stays. */
  reset(): Effect.Effect<void> {
    return Effect.andThen(
      Effect.all([this.stopIdle(), this.core.clearQueues, Ref.set(this.core.messages, [])]),
      Effect.sync(() => this.session?.clear()),
    );
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
  resume(maxAgeMs: number): Effect.Effect<boolean> {
    const self = this;
    return Effect.gen(function* () {
      if (!(yield* self.quiet())) return false;
      const messages = self.history();
      const { missing, ok } = unfinished(messages);
      const last = messages.at(-1);
      if (!ok || !last || self.now() - last.timestamp > maxAgeMs) return false;
      if (missing.length > 0) {
        const more: BrainMessage[] = missing.map((call) => ({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: resumedUnknown }],
          isError: true,
          timestamp: self.now(),
        }));
        for (const m of more) yield* self.save(m);
        yield* Ref.update(self.core.messages, (all) => [...all, ...more]);
      }
      yield* self.stopIdle();
      self.accounting.begin();
      yield* self.continueRun();
      return true;
    });
  }

  private quiet(): Effect.Effect<boolean> {
    return Effect.map(this.core.hasQueued, (queued) => !this.accounting.active() && !queued);
  }

  private idleAfter() {
    return this.options.idleFoldAfterMs ?? 10 * 60_000;
  }

  private idleAt() {
    return this.options.idleFoldAt ?? Math.trunc((this.folding.budget * 4) / 5);
  }

  private stopIdle(): Effect.Effect<void> {
    return FiberHandle.clear(this.idleFold);
  }

  // Folding when the run ends would give the owner a lossy summary a minute later; folding when they have gone keeps
  // the conversation as it was while they are likely to go on with it.
  private idleLater(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const after = this.idleAfter();
      if (after < 0 || estimateTokens(this.history()) <= this.idleAt()) return Effect.void;
      // What stopIdle cancels is the wait: a fold under way goes on, and is dropped if something came in meanwhile.
      return Effect.asVoid(FiberHandle.run(this.idleFold, Effect.andThen(Effect.sleep(after), FiberSet.run(this.fibers, this.foldIdle()))));
    });
  }

  private foldIdle(): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      if (self.closed || !(yield* self.quiet())) return;
      if (self.options.wakeSoon?.(self.idleAfter()) === true) return;
      const before = self.history();
      const { result } = yield* self.fold(before, declared(self.toolset), { ...self.folding, budget: self.idleAt() }, "idle");
      if (!result) return;
      self.folds = new Map();
      // What came in while the summary was being made is not lost: the fold is dropped, and done again when it is idle next.
      if (self.closed || !(yield* self.quiet()) || !sameMessages(self.history(), before)) return;
      yield* Ref.set(self.core.messages, result.messages);
      yield* self.save(result.summary);
      self.refreshPrefix();
    });
  }

  private closeOnce(): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      self.closed = true;
      yield* self.stopIdle();
      yield* self.core.abort;
      yield* self.core.idle;
      if (self.tasks) yield* self.tasks.close;
      // A queued continuation cancelled before it starts has no end event.
      yield* self.ended();
      self.listeners.clear();
    });
  }
}

/** Where Promise code (oar's runtime, the orchestrator's host, the command line) keeps a brain: the fibers its Effects
 * run on, and the scope the brain's own is a child of, so that it ends with the owner's at the latest. */
export interface BrainOwner {
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly scope: Scope.Scope;
}

export interface BrainHandle {
  readonly brain: Brain;
  readonly send: (message: BrainMessage) => Promise<void>;
  readonly later: (message: BrainMessage) => Promise<void>;
  readonly ask: (message: BrainMessage) => Promise<string>;
  readonly stop: () => Promise<void>;
  readonly resume: (maxAgeMs: number) => Promise<boolean>;
  readonly queued: () => Promise<boolean>;
  readonly reset: () => Promise<void>;
  /** Run in order with the events: the brain waits for none of what it starts. */
  readonly subscribe: (listener: (e: BrainEvent) => void) => () => void;
  /** Closes the brain's scope; every caller waits for the one close. */
  readonly close: () => Promise<void>;
  readonly history: () => BrainMessage[];
  readonly busy: () => boolean;
  readonly progress: () => RunSnapshot;
  readonly tools: () => readonly Tool[];
  readonly skills: () => SkillInfo[];
  readonly mcpStatus: () => McpStatus;
  readonly memoryNews: () => string;
}

export async function openBrain(owner: BrainOwner, options: BrainOptions): Promise<BrainHandle> {
  const run = owner.run;
  const scope = await run(Scope.fork(owner.scope));
  let brain: Brain;
  try {
    brain = await run(Scope.provide(Brain.make(options), scope));
  } catch (e) {
    await run(Scope.close(scope, Exit.void));
    throw e;
  }
  let closing: Promise<void> | undefined;
  return {
    brain,
    send: (m) => run(brain.send(m)),
    later: (m) => run(brain.later(m)),
    ask: (m) => run(brain.ask(m)),
    stop: () => run(brain.stop()),
    resume: (maxAgeMs) => run(brain.resume(maxAgeMs)),
    queued: () => run(brain.queued()),
    reset: () => run(brain.reset()),
    subscribe: (listener) => brain.subscribe((e) => Effect.sync(() => listener(e))),
    close: () => (closing ??= run(Scope.close(scope, Exit.void))),
    history: () => brain.history(),
    busy: () => brain.busy(),
    progress: () => brain.progress(),
    tools: () => brain.tools(),
    skills: () => brain.skills(),
    mcpStatus: () => brain.mcpStatus(),
    memoryNews: () => brain.memoryNews(),
  };
}

/** For code with no service behind it (the command line, a test): fibers of its own, and a scope only the brain's close
 * ends. */
export const standaloneOwner = (): BrainOwner => ({ run: (effect) => Effect.runPromise(effect), scope: Scope.makeUnsafe() });
