import { join } from "node:path";

import { Clock, Deferred, Effect, FiberHandle, FiberSet, PubSub, Ref, type Scope, Stream } from "effect";

import type { ModelClient } from "@vibevalley/ai/client";
import type { ToolCall, ToolDeclaration, Usage } from "@vibevalley/ai/messages";
import type { ThinkingLevel } from "@vibevalley/ai/models";

import { applyPlan, type Compacted, type CompactionOptions, compactInPlace, estimateTokens, planCompaction, type Summarized } from "./compaction.ts";
import { AgentClosed, type AgentFailed, agentFailed, toolFailed } from "./core/errors.ts";
import { type Agent, type AgentEvent, make, type Tool } from "./core/loop.ts";
import { stopped } from "./core/tool.ts";
import { type McpServer, connectAll } from "./mcp.ts";
import { fileMemory, type MemoryPort } from "./memory.ts";
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

export const sessionUnfinished = async (file: string) => unfinished(await loadSession(file)).ok;

const sameMessages = (a: readonly BrainMessage[], b: readonly BrainMessage[]) => a.length === b.length && a.at(-1)?.timestamp === b.at(-1)?.timestamp;

export interface Brain {
  /** Starts a run when idle, or steers into the active run. */
  readonly send: (message: BrainMessage) => Effect.Effect<void>;
  /** Starts a run when idle, or queues as a follow-up after the active run. */
  readonly later: (message: BrainMessage) => Effect.Effect<void>;
  readonly ask: (message: BrainMessage) => Effect.Effect<string, AgentClosed>;
  /** Its events, in order, from the moment this is run: subscribed before it returns. */
  readonly events: Effect.Effect<Stream.Stream<BrainEvent>, never, Scope.Scope>;
  readonly busy: () => boolean;
  readonly progress: () => RunSnapshot;
  readonly stop: Effect.Effect<void>;
  readonly history: () => BrainMessage[];
  readonly queued: Effect.Effect<boolean>;
  readonly tools: () => readonly Tool[];
  readonly reset: Effect.Effect<void>;
  readonly skills: Effect.Effect<SkillInfo[]>;
  readonly mcpStatus: () => McpStatus;
  /** Diff of `MEMORY.md` (`+` / `−` lines) since last seen by the model, or `""` when unchanged. */
  readonly memoryNews: Effect.Effect<string>;
  readonly resume: (maxAgeMs: number) => Effect.Effect<boolean>;
}

export const makeBrain = (options: BrainOptions): Effect.Effect<Brain, AgentFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const mcp = yield* Effect.acquireRelease(connectAll(options.mcpServers ?? []), (m) => Effect.promise(() => m.close()));
    const clock = yield* Clock.Clock;
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

    const hub = yield* PubSub.unbounded<BrainEvent>();
    const publish = (e: BrainEvent) => PubSub.publish(hub, e);
    const accounting = new RunAccounting();
    const fibers = yield* FiberSet.make();
    const idleFold = yield* FiberHandle.make();
    const waiters = yield* Ref.make<Deferred.Deferred<RunResult>[]>([]);
    const folds = yield* Ref.make(new Map<string, CompactionSummaryMessage>());
    let steps = 0;
    let stopping = false;
    let closed = false;
    let sent: Record<string, string> | undefined;
    let prefix = "";
    let parts: PromptPart[] = [];
    let requestPrefix = "";
    let requestTools: ToolDeclaration[] = [];
    let knownMemory: string[] = [];
    let core: Agent<Own> | undefined;
    const loop = () => {
      if (!core) throw new Error("the agent loop is not ready");
      return core;
    };
    let todos: TodoRunner | undefined;

    const hostTools = [...(options.tools ?? []), ...mcp.tools];
    const memoryPort = options.noMemory === true ? undefined : (options.memory ?? fileMemory(options.home, now));
    const own = selfTools({ now, home: options.home, skills: scanned, memory: memoryPort ?? false });
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
      // Preserve the active todo graph across compaction when earlier turns are summarized away.
      folding = { ...folding, append: () => Effect.suspend(() => todos?.summary ?? Effect.succeed("")) };
    }

    const promptParts = Effect.gen(function* () {
      const found = yield* Effect.promise(scanned);
      const memory = memoryPort ? (yield* memoryPort.read()).prompt : "";
      const all: PromptPart[] = [
        { name: "instructions", text: options.instructions.trim() },
        { name: "env", text: words.envSection(options.cwd) },
      ];
      if (found.length > 0) all.push({ name: "skills", text: words.skillsSection(skillIndex(found)) });
      if (memory) all.push({ name: "memory", text: words.memorySection(memory) });
      return all.filter((p) => p.text !== "");
    });
    const memoryLines = memoryPort ? Effect.map(memoryPort.read(), (r) => [...r.lines]) : Effect.succeed<string[]>([]);

    /** Rebuild system prefix only at startup and post-compaction so prompt cache stays warm mid-run. */
    const refreshPrefix = Effect.gen(function* () {
      parts = yield* promptParts;
      prefix = joinParts(parts);
      knownMemory = yield* memoryLines;
      sent = undefined;
    });

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

    /** Compacts using the prior request's prefix and tools so the summary call hits the prompt cache. */
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
        Effect.catchDefect((err) => Effect.map(Effect.logError(`agent ${options.name}: cannot fold the conversation:`, err), (): Summarized => ({}))),
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
      // Drop the idle summary if new messages arrived while summarizing.
      if (closed || !(yield* quiet) || !sameMessages(history(), before)) return;
      yield* Ref.set(loop().messages, result.messages);
      yield* save(result.summary);
      yield* refreshPrefix;
    });

    const idleLater = Effect.suspend(() => {
      const after = idleAfter();
      if (after < 0 || estimateTokens(history()) <= idleAt()) return Effect.void;
      return Effect.asVoid(FiberHandle.run(idleFold, Effect.andThen(Effect.sleep(after), FiberSet.run(fibers, foldIdle))));
    });

    const continueRun: Effect.Effect<void> = Effect.suspend(() => {
      steps = 0;
      // `stop` can drain the queue right after `hasQueued`; settle directly when nothing remains to continue.
      return Effect.catchTags(loop().continue, {
        CannotContinue: () => ended,
        AgentBusy: (err) => Effect.logWarning(`agent ${options.name}: cannot continue run:`, err),
      });
    });

    const ended: Effect.Effect<void> = Effect.gen(function* () {
      const alive = () => !closed;
      if (alive() && (yield* loop().hasQueued)) return yield* continueRun;
      // Persist threshold compactions already used mid-run; otherwise defer compaction until idle.
      const folded = (yield* Ref.get(folds)).size > 0;
      if (alive() && folded) yield* settleFold;
      if (alive() && (yield* loop().hasQueued)) return yield* continueRun;
      if (!accounting.active()) return;
      const result = accounting.settle(stopping || !alive());
      stopping = false;
      if (alive() && !folded) yield* idleLater;
      const settled = yield* Ref.getAndSet(waiters, []);
      yield* publish({ type: "agent_settled", run: result, progress: accounting.snapshot() });
      yield* Effect.forEach(settled, (w) => Deferred.succeed(w, result), { discard: true });
      if (todos && !result.aborted && !result.failed && alive()) {
        const text = yield* todos.nudge;
        if (text) yield* later(taskMessage(text, now()));
      }
    });

    /** The loop's events, in order: each message saved before it is passed on; after a run's end, what follows it. */
    const follow = (e: CoreEvent) =>
      Effect.gen(function* () {
        observeRun(e);
        // Skip persisting partial/aborted messages during shutdown so the next startup can resume from the cut point.
        if (e.type === "message_end" && !closed) yield* save(e.message);
        yield* publish(e);
        if (e.type === "agent_end") yield* FiberSet.run(fibers, Effect.andThen(loop().idle, ended));
      });

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
      const reminders = yield* makeReminders(options.home, (due) =>
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
      finishTurn: (turn) =>
        Effect.sync(() => {
          steps++;
          return steps >= maxSteps || turn.stopped ? "end" : undefined;
        }),
      onEvent: follow,
      stoppedText: stopped,
    });
    const brainCore = core;
    // Registered last so LIFO finalization aborts and settles the brain while `core`, `fibers`, and `mcp` are still alive.
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
    if (todos) yield* FiberSet.run(fibers, todos.recover);

    return {
      send: (message) => deliver(message, true),
      later,
      ask: (message) =>
        Effect.gen(function* () {
          if (closed) return yield* AgentClosed.make({ message: "the agent is closed" });
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
            yield* Effect.forEach(more, (m) => save(m), { discard: true });
            yield* Ref.update(brainCore.messages, (all) => [...all, ...more]);
          }
          yield* stopIdle;
          accounting.begin();
          yield* continueRun;
          return true;
        }),
    } satisfies Brain;
  });
