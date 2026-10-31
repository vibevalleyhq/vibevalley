// VibeValley's own agent, on the farm's loop (agent/loop). A message is saved before its message_end is passed on. Past its
// budget the older part of the conversation is folded into a summary: for a request as soon as it is too long, in the
// file once the run is over; past idleFoldAt, once it has been idle idleFoldAfterMs. The system prompt is made when the
// agent starts and after each fold, never per request: what changes meanwhile (the time, the host's situation, new
// memory) goes in the newest input, so the start of every request stays the cached one.

import { join } from "node:path";

import { Clock, Deferred, Effect, Exit, Fiber, FiberHandle, FiberSet, PubSub, Ref, Scope, Stream } from "effect";

import type { ModelClient } from "@vibevalley/ai/client";
import type { ToolCall, ToolDeclaration, Usage } from "@vibevalley/ai/messages";
import type { ThinkingLevel } from "@vibevalley/ai/models";

import { applyPlan, type Compacted, type CompactionOptions, compactInPlace, estimateTokens, planCompaction, type Summarized } from "./compaction.ts";
import { AgentClosed, type AgentFailed, agentFailed, toolFailed } from "./core/errors.ts";
import { type Agent, type AgentEvent, make, type Tool } from "./core/loop.ts";
import { stopped } from "./core/tool.ts";
import { type McpServer, connectAll } from "./mcp.ts";
import { memoryFileLines, readMemory } from "./memory.ts";
import { type BrainMessage, type CompactionSummaryMessage, type CustomMessage, customMessage, messageText, requestContext, userMessage } from "./messages.ts";
import { changedParts, joinParts, prefixHashes, type PromptPart } from "./prefix.ts";
import { agent as words } from "./prompts.ts";
import { makeReminders } from "./reminders.ts";
import { RunAccounting, type RunResult, type RunSnapshot } from "./run.ts";
import { type Subagent, selfTools, subagentInstructions, subagentTool } from "./self.ts";
import { appendSession, clearSession, loadSession } from "./session.ts";
import { defaultSkillDirs, scanSkills, type SkillInfo, skillIndex } from "./skills.ts";
import { finished, type Todo } from "./todo.ts";
import type { TodoStore } from "./todoStore.ts";
import { type TodoRunner, makeTodoRunner, todoTools, watchedStore } from "./todoTools.ts";

type Own = CustomMessage | CompactionSummaryMessage;

export type CoreEvent = AgentEvent<Own>;

export type BrainEvent =
  | CoreEvent
  /** progress: as it stood when the run settled, before anything after it began. */
  | { readonly type: "agent_settled"; readonly run: RunResult; readonly progress: RunSnapshot }
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
  /** Its own todos after a change, whoever made it; empty once finished. */
  | { readonly type: "todos_changed"; readonly todos: Todo[] }
  /** The last of its events, once it has closed: a reader's stream ends after it. */
  | { readonly type: "agent_closed" };

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
  /** Its own todos and the tools to add and mark them; absent, none. */
  readonly todos?: TodoStore;
  /** Subagents out on its todos at once; 3 when absent. */
  readonly maxSubagents?: number;
  /** Times a run that stops with its own todos ready is reminded of them while the graph stays the same; 3 when absent. */
  readonly maxNudges?: number;
  /** Absent: when it keeps a session. */
  readonly reminders?: boolean;
}

export interface McpStatus {
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

/** The calls of the last answer that have no result; ok is false when there is nothing to go on with: the model spoke
 * last with nothing left to do, or the run was stopped or failed. */
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
export const sessionUnfinished = async (file: string) => unfinished(await loadSession(file)).ok;

const sameMessages = (a: readonly BrainMessage[], b: readonly BrainMessage[]) => a.length === b.length && a.at(-1)?.timestamp === b.at(-1)?.timestamp;

export interface Brain {
  /** Starts a run when idle, steers the one under way otherwise. */
  readonly send: (message: BrainMessage) => Effect.Effect<void>;
  /** Taken when the run would stop (a follow-up); starts a run when idle. */
  readonly later: (message: BrainMessage) => Effect.Effect<void>;
  /** What the run it starts or joins ends up saying. */
  readonly ask: (message: BrainMessage) => Effect.Effect<string, AgentClosed>;
  /** Its events, in order, from the moment this is run: subscribed before it returns. */
  readonly events: Effect.Effect<Stream.Stream<BrainEvent>, never, Scope.Scope>;
  readonly busy: () => boolean;
  readonly progress: () => RunSnapshot;
  /** Stops the run under way and calls back the subagents out on its todos. */
  readonly stop: Effect.Effect<void>;
  /** As it is now. */
  readonly history: () => BrainMessage[];
  /** Lines sent while it works that no turn has taken yet. */
  readonly queued: Effect.Effect<boolean>;
  readonly tools: () => readonly Tool[];
  /** The memory stays. */
  readonly reset: Effect.Effect<void>;
  readonly skills: Effect.Effect<SkillInfo[]>;
  readonly mcpStatus: () => McpStatus;
  /** What MEMORY.md gained (+) and lost (−) since the model last knew it, as one block for the newest input; "" when
   * nothing. What it returns counts as known from then on. */
  readonly memoryNews: Effect.Effect<string>;
  /** Goes on with the run the conversation was cut off in; true when it does. Each call of the last answer without a
   * result is given one, failed, saying it is not known whether it was done. Not when it is busy, the run ended or was
   * stopped, or its last message is older than maxAgeMs. */
  readonly resume: (maxAgeMs: number) => Effect.Effect<boolean>;
}

/** Connects to its MCP servers first: one that cannot be reached is left out (mcpStatus). Everything it starts is in
 * the scope it is made in, and closing that closes it. */
export const makeBrain = (options: BrainOptions): Effect.Effect<Brain, AgentFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const mcp = yield* Effect.acquireRelease(Effect.tryPromise({ try: (signal) => connectAll(options.mcpServers ?? [], signal), catch: agentFailed }), (m) =>
      Effect.promise(() => m.close()),
    );
    const clock = yield* Clock.Clock;
    /** The Clock of the scope it was made in. */
    const now = () => clock.currentTimeMillisUnsafe();
    const maxSteps = options.maxSteps ?? 40;
    const sessionName = options.session || options.name;
    const sessionFile = options.noSession === true ? undefined : join(options.home, sessionName + ".jsonl");
    const skillDirs = options.noSkills === true ? [] : (options.skills ?? defaultSkillDirs(options.cwd));
    const scanned = () => scanSkills(skillDirs);
    let folding: CompactionOptions = {
      home: options.home,
      session: sessionName,
      llm: options.llm,
      budget: options.contextTokens ?? 120_000,
      keepRecent: options.keepRecent ?? 12,
      keepSaid: 3,
      now,
    };

    // Its events go out on a hub: a subscriber reads them in order, at its own pace, and its stream ends after
    // agent_closed. The hub is not shut down, so a reader outliving the brain's scope still gets what came before.
    const hub = yield* PubSub.unbounded<BrainEvent>();
    const publish = (e: BrainEvent) => PubSub.publish(hub, e);
    const accounting = new RunAccounting();
    /** What follows a run, an idle fold under way, the first look at its todos: fibers of the brain's scope. */
    const fibers = yield* FiberSet.make();
    const idleFold = yield* FiberHandle.make();
    const waiters = yield* Ref.make<Deferred.Deferred<RunResult>[]>([]);
    /** Made once per place. */
    const folds = yield* Ref.make(new Map<string, CompactionSummaryMessage>());
    let steps = 0;
    let stopping = false;
    let closed = false;
    /** What the last request's prompt start hashed to, per part; absent before the first request and after a compaction. */
    let sent: Record<string, string> | undefined;
    /** The system prompt and its parts, as refreshPrefix made them. */
    let prefix = "";
    let parts: PromptPart[] = [];
    /** What the request under way starts with. */
    let requestPrefix = "";
    let requestTools: ToolDeclaration[] = [];
    /** The lines of MEMORY.md the model knows: the snapshot's, then as memoryNews told it. */
    let knownMemory: string[] = [];
    // Made below, before anything can call the brain: the loop needs the tools, and some tools need the loop.
    let core: Agent<Own> | undefined;
    const loop = () => core!;
    let todos: TodoRunner | undefined;

    const hostTools = [...(options.tools ?? []), ...mcp.tools];
    const own = selfTools({ now, home: options.home, skills: scanned, memory: options.noMemory !== true });
    const subagent: Subagent | undefined =
      options.noSubagents === true
        ? undefined
        : (brief, label) =>
            Effect.scoped(
              Effect.gen(function* () {
                const h = yield* makeBrain({
                  name: options.name + words.subagentNameSuffix,
                  instructions: subagentInstructions(options.name),
                  llm: options.llm,
                  ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
                  home: options.home,
                  cwd: options.cwd,
                  tools: hostTools,
                  ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
                  skills: skillDirs,
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
    if (subagent) own.push(subagentTool(subagent));
    const todoStore = options.todos ? watchedStore(options.todos, (g) => publish({ type: "todos_changed", todos: finished(g) ? [] : g })) : undefined;
    if (todoStore) {
      own.push(
        ...todoTools(
          todoStore,
          subagent !== undefined,
          Effect.suspend(() => todos?.advance ?? Effect.void),
        ),
      );
      // A fold replaces the turns that showed the graph: the summary carries it on.
      folding = { ...folding, append: () => Effect.suspend(() => todos?.summary ?? Effect.succeed("")) };
    }

    /** The parts of the system prompt, in order, named instructions, env, skills, memory; an empty one is left out. */
    const promptParts = Effect.gen(function* () {
      const found = yield* Effect.promise(scanned);
      const memory = options.noMemory === true ? "" : (yield* Effect.promise(() => readMemory(options.home))).prompt;
      const all: PromptPart[] = [
        { name: "instructions", text: options.instructions.trim() },
        { name: "env", text: words.envSection(options.cwd) },
      ];
      if (found.length > 0) all.push({ name: "skills", text: words.skillsSection(skillIndex(found)) });
      if (memory) all.push({ name: "memory", text: words.memorySection(memory) });
      return all.filter((p) => p.text !== "");
    });
    const memoryLines = options.noMemory === true ? Effect.succeed<string[]>([]) : Effect.promise(() => memoryFileLines(options.home));

    /** When the agent starts and after a fold: the prompt changes only where the cache is lost anyway. */
    const refreshPrefix = Effect.gen(function* () {
      parts = yield* promptParts;
      prefix = joinParts(parts);
      knownMemory = yield* memoryLines;
      sent = undefined;
    });

    /** Told as prefix_changed; the first request, and the first after a compaction, set what the next is compared with. */
    const noteChanges = (all: readonly PromptPart[], tools: readonly ToolDeclaration[]) => {
      const hashes = prefixHashes(all, tools);
      const changed = changedParts(sent, hashes);
      sent = hashes;
      return changed.length > 0 ? publish({ type: "prefix_changed", parts: changed }) : Effect.void;
    };

    const save = (message: BrainMessage) =>
      sessionFile === undefined
        ? Effect.void
        : Effect.tryPromise({ try: () => appendSession(sessionFile, message), catch: agentFailed }).pipe(
            Effect.catch((err) => Effect.logError(`agent ${options.name}: cannot save the conversation:`, err)),
          );

    /** The summary is asked with the request's own start, the one the request before was sent with: its cache is read.
     * fresh: the summary was made now, not taken from an earlier request; whoever uses it makes the prompt anew.
     * Interrupted, it ends with no summary. */
    const fold = Effect.fnUntraced(function* (
      messages: readonly BrainMessage[],
      tools: readonly ToolDeclaration[],
      with_: CompactionOptions,
      reason: FoldReason,
    ): Effect.fn.Return<Folded> {
      const plan = planCompaction(messages, with_);
      if (!plan) return { fresh: false };
      const key = `${plan.cut}:${messages[plan.cut]?.timestamp ?? 0}`;
      const known = (yield* Ref.get(folds)).get(key);
      if (known) return { result: applyPlan(plan, known), fresh: false };
      yield* publish({ type: "compaction_start", reason });
      const { summary, usage } = yield* compactInPlace(plan, with_, prefix, tools).pipe(
        Effect.catchDefect((err) => Effect.as(Effect.logError(`agent ${options.name}: cannot fold the conversation:`, err), {} as Summarized)),
        Effect.onInterrupt(() => publish({ type: "compaction_end", reason })),
      );
      yield* publish({ type: "compaction_end", reason, ...(summary ? { compaction: summary } : {}), ...(usage ? { usage } : {}) });
      if (!summary) return { fresh: false };
      yield* Ref.update(folds, (m) => new Map(m).set(key, summary));
      return { result: applyPlan(plan, summary), fresh: true };
    });

    const history = () => [...Ref.getUnsafe(loop().messages)];
    let toolList: readonly Tool[] = [];
    const toolset = () => toolList;

    /** A run that folded for a request keeps the fold: the summary it was answered with is saved. */
    const settleFold = Effect.gen(function* () {
      const { result, fresh } = yield* fold(history(), declared(toolset()), folding, "threshold");
      if (!result) return;
      if (fresh) yield* refreshPrefix;
      yield* Ref.set(folds, new Map());
      yield* Ref.set(loop().messages, result.messages);
      yield* save(result.summary);
    });

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

    const quiet = Effect.map(
      Effect.suspend(() => loop().hasQueued),
      (queued) => !accounting.active() && !queued,
    );
    const idleAfter = () => options.idleFoldAfterMs ?? 10 * 60_000;
    const idleAt = () => options.idleFoldAt ?? Math.trunc((folding.budget * 4) / 5);
    const stopIdle = FiberHandle.clear(idleFold);

    const foldIdle = Effect.gen(function* () {
      if (closed || !(yield* quiet)) return;
      if (options.wakeSoon?.(idleAfter()) === true) return;
      const before = history();
      const { result } = yield* fold(before, declared(toolset()), { ...folding, budget: idleAt() }, "idle");
      if (!result) return;
      yield* Ref.set(folds, new Map());
      // What came in while the summary was being made is not lost: the fold is dropped, and done again when it is idle next.
      if (closed || !(yield* quiet) || !sameMessages(history(), before)) return;
      yield* Ref.set(loop().messages, result.messages);
      yield* save(result.summary);
      yield* refreshPrefix;
    });

    // Folding when the run ends would give the owner a lossy summary a minute later; folding when they have gone keeps
    // the conversation as it was while they are likely to go on with it.
    const idleLater = Effect.suspend(() => {
      const after = idleAfter();
      if (after < 0 || estimateTokens(history()) <= idleAt()) return Effect.void;
      // What stopIdle cancels is the wait: a fold under way goes on, and is dropped if something came in meanwhile.
      return Effect.asVoid(FiberHandle.run(idleFold, Effect.andThen(Effect.sleep(after), FiberSet.run(fibers, foldIdle))));
    });

    const continueRun: Effect.Effect<void> = Effect.suspend(() => {
      steps = 0;
      // Stop can clear the queue after its check: then no run starts, and no end event will follow.
      return Effect.catch(loop().continue, () => ended);
    });

    const ended: Effect.Effect<void> = Effect.gen(function* () {
      const alive = () => !closed;
      if (alive() && (yield* loop().hasQueued)) return yield* continueRun;
      // Only a fold a request already used is saved now; otherwise the conversation stays as it was until it is idle.
      const folded = (yield* Ref.get(folds)).size > 0;
      if (alive() && folded) yield* settleFold;
      // Admission stays attached to this logical run until compaction and all queued input are settled.
      if (alive() && (yield* loop().hasQueued)) return yield* continueRun;
      if (!accounting.active()) return;
      const result = accounting.settle(stopping || !alive());
      stopping = false;
      if (alive() && !folded) yield* idleLater;
      const settled = yield* Ref.getAndSet(waiters, []);
      yield* publish({ type: "agent_settled", run: result, progress: accounting.snapshot() });
      for (const w of settled) yield* Deferred.succeed(w, result);
      if (todos && !result.aborted && !result.failed && alive()) {
        const text = yield* todos.nudge;
        if (text) yield* later(taskMessage(text, now()));
      }
    });

    /** The loop's events, in order: each message saved before it is passed on; after a run's end, what follows it. */
    const follow = (e: CoreEvent) =>
      Effect.gen(function* () {
        observeRun(e);
        // Not what closing it made (the answer cut off, its tools' "stopped"): the file ends where the run was cut, as
        // after a crash, and resume goes on from there.
        if (e.type === "message_end" && !closed) yield* save(e.message);
        yield* publish(e);
        // The run is idle once its fiber has ended, after this event.
        if (e.type === "agent_end") yield* FiberSet.run(fibers, Effect.andThen(loop().idle, ended));
      });

    /** The fold before the prompt: a fold makes the prompt anew, and this request is the first to start with it. A stopped
     * run asks for no summary: its request ends at once. */
    const prepare = (messages: readonly BrainMessage[], stoppedRun: boolean) =>
      Effect.gen(function* () {
        const tools = declared(toolset());
        const { result, fresh }: Folded = stoppedRun ? { fresh: false } : yield* fold(messages, tools, folding, "threshold");
        if (result && fresh) yield* refreshPrefix;
        requestPrefix = prefix;
        requestTools = tools;
        yield* noteChanges(parts, tools);
        return result?.messages;
      });

    const deliver = (message: BrainMessage, steer: boolean): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (closed) return Effect.void;
        if (accounting.active()) return steer ? loop().steer(message) : loop().followUp(message);
        // Begun at once: what comes before the run starts joins it.
        accounting.begin();
        steps = 0;
        return Effect.andThen(
          stopIdle,
          Effect.catch(loop().prompt([message]), (err) => Effect.logError(`agent ${options.name}: cannot start a run:`, err)),
        );
      });
    const later = (message: BrainMessage) => deliver(message, false);

    yield* refreshPrefix;
    let tools = allowed([...hostTools, ...own], options.disallowedTools);
    if (options.reminders ?? sessionFile !== undefined) {
      const reminders = yield* makeReminders(options.home, now, (due) =>
        Effect.forEach(due, (text) => later(customMessage("reminder", text, now())), { discard: true }),
      );
      tools = allowed([...tools, ...reminders.tools], options.disallowedTools);
    }
    if (todoStore)
      todos = yield* makeTodoRunner(todoStore, subagent, (text) => later(taskMessage(text, now())), options.maxSubagents ?? 3, options.maxNudges ?? 3);
    toolList = tools;
    core = yield* make<Own>({
      llm: options.llm.service,
      model: options.llm.model,
      thinkingLevel: options.thinkingLevel ?? "off",
      tools,
      messages: sessionFile === undefined ? [] : yield* Effect.promise(() => loadSession(sessionFile)),
      apiKey: () => options.llm.apiKey?.() ?? "",
      toLlm: (messages) => requestContext(requestPrefix, requestTools, messages),
      prepareRequest: prepare,
      // A stop that came while the tools ran ends the run with their results, as the model's answer would.
      finishTurn: (turn) =>
        Effect.sync(() => {
          steps++;
          return steps >= maxSteps || turn.stopped ? "end" : undefined;
        }),
      onEvent: follow,
      stoppedText: stopped,
    });
    const brainCore = core;
    // Finalizers run last in, first out: the brain closes while its loop, fibers and subagents are still there.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true;
        yield* stopIdle;
        yield* brainCore.abort;
        yield* brainCore.idle;
        if (todos) yield* todos.close;
        // A queued continuation cancelled before it starts has no end event.
        yield* ended;
        yield* publish({ type: "agent_closed" });
      }),
    );
    // What a process that went left out goes out again, now that the agent can be told.
    if (todos) yield* FiberSet.run(fibers, todos.recover);

    return {
      send: (message) => deliver(message, true),
      later,
      ask: (message) =>
        Effect.gen(function* () {
          if (closed) return yield* new AgentClosed({ message: "the agent is closed" });
          const answer = yield* Deferred.make<RunResult>();
          yield* Ref.update(waiters, (all) => [...all, answer]);
          yield* deliver(message, true);
          const r = yield* Effect.ensuring(
            Deferred.await(answer),
            Ref.update(waiters, (all) => all.filter((w) => w !== answer)),
          );
          return r.text;
        }),
      events: Effect.map(PubSub.subscribe(hub), (sub) => Stream.fromSubscription(sub).pipe(Stream.takeUntil((e) => e.type === "agent_closed"))),
      busy: () => accounting.active(),
      progress: () => accounting.snapshot(),
      stop: Effect.gen(function* () {
        if (todos) yield* todos.stop;
        yield* brainCore.clearQueues;
        if (accounting.active()) stopping = true;
        yield* brainCore.abort;
      }),
      history,
      queued: brainCore.hasQueued,
      tools: toolset,
      reset: Effect.andThen(
        Effect.all([stopIdle, brainCore.clearQueues, Ref.set(brainCore.messages, [])]),
        sessionFile === undefined ? Effect.void : Effect.promise(() => clearSession(sessionFile)),
      ),
      skills: Effect.promise(scanned),
      mcpStatus: () => ({ toolCount: mcp.tools.length, failed: [...mcp.failed] }),
      memoryNews: Effect.gen(function* () {
        if (options.noMemory === true) return "";
        const current = yield* memoryLines;
        const before = knownMemory;
        knownMemory = current;
        const lines = [...current.filter((l) => !before.includes(l)).map((l) => "+ " + l), ...before.filter((l) => !current.includes(l)).map((l) => "− " + l)];
        return lines.length === 0 ? "" : words.memoryNews(lines.join("\n"));
      }),
      resume: (maxAgeMs) =>
        Effect.gen(function* () {
          if (!(yield* quiet)) return false;
          const messages = history();
          const { missing, ok } = unfinished(messages);
          const last = messages.at(-1);
          if (!ok || !last || now() - last.timestamp > maxAgeMs) return false;
          if (missing.length > 0) {
            const more: BrainMessage[] = missing.map((call) => ({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: resumedUnknown }],
              isError: true,
              timestamp: now(),
            }));
            for (const m of more) yield* save(m);
            yield* Ref.update(brainCore.messages, (all) => [...all, ...more]);
          }
          yield* stopIdle;
          accounting.begin();
          yield* continueRun;
          return true;
        }),
    } satisfies Brain;
  });

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
  /** In order with the events, each once it is published: the handle subscribed as it opened, so none is missed. */
  readonly subscribe: (listener: (e: BrainEvent) => void) => () => void;
  /** Closes the brain's scope; every caller waits for the one close. */
  readonly close: () => Promise<void>;
  readonly history: () => BrainMessage[];
  readonly busy: () => boolean;
  readonly progress: () => RunSnapshot;
  readonly tools: () => readonly Tool[];
  readonly skills: () => Promise<SkillInfo[]>;
  readonly mcpStatus: () => McpStatus;
  readonly memoryNews: () => Promise<string>;
}

export async function openBrain(owner: BrainOwner, options: BrainOptions): Promise<BrainHandle> {
  const run = owner.run;
  const scope = await run(Scope.fork(owner.scope));
  // Listeners are Promise code's: one reader, opened with the brain, hands each event to all of them. It is a fiber of
  // the owner's, not the brain's: it reads on to agent_closed, so what closing the brain says is heard too.
  const listeners = new Set<(e: BrainEvent) => void>();
  const reading = await run(Scope.fork(owner.scope));
  let brain: Brain;
  let reader: Fiber.Fiber<void>;
  try {
    brain = await run(Scope.provide(makeBrain(options), scope));
    reader = await run(
      Scope.provide(
        Effect.flatMap(brain.events, (events) =>
          Effect.forkScoped(
            Stream.runForEach(events, (e) =>
              Effect.sync(() => {
                for (const l of listeners) l(e);
              }),
            ),
          ),
        ),
        reading,
      ),
    );
  } catch (e) {
    await run(Effect.andThen(Scope.close(scope, Exit.void), Scope.close(reading, Exit.void)));
    throw e;
  }
  let closing: Promise<void> | undefined;
  return {
    brain,
    send: (m) => run(brain.send(m)),
    later: (m) => run(brain.later(m)),
    ask: (m) => run(brain.ask(m)),
    stop: () => run(brain.stop),
    resume: (maxAgeMs) => run(brain.resume(maxAgeMs)),
    queued: () => run(brain.queued),
    reset: () => run(brain.reset),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    // The reader ends on agent_closed, or was interrupted with the owner's scope: either way it is done.
    close: () => (closing ??= run(Effect.andThen(Effect.andThen(Scope.close(scope, Exit.void), Fiber.await(reader)), Scope.close(reading, Exit.void)))),
    history: () => brain.history(),
    busy: () => brain.busy(),
    progress: () => brain.progress(),
    tools: () => brain.tools(),
    skills: () => run(brain.skills),
    mcpStatus: () => brain.mcpStatus(),
    memoryNews: () => run(brain.memoryNews),
  };
}

/** For code with no service behind it (the command line, a test): fibers of its own, and a scope only the brain's close
 * ends. */
export const standaloneOwner = (): BrainOwner => ({ run: (effect) => Effect.runPromise(effect), scope: Scope.makeUnsafe() });
