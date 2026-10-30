// Every input carries a route the host does not read: the one that owns the agent says what it means and where its words go.
// An input given while the agent is busy may be taken after one given later; the words follow the agent's events, so they go
// to the route of the input taken last, and the tools read that route too.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Cause, Clock, Data, Deferred, Effect, Exit, Fiber, Queue, Scope, Semaphore, Stream } from "effect";

import { Brain, type BrainEvent, sessionUnfinished } from "@vibevalley/agent/brain";
import type { Tool } from "@vibevalley/agent/core/loop";
import { memoryFile } from "@vibevalley/agent/memory";
import { type BrainMessage, type CustomMessage, customMessage, messageText } from "@vibevalley/agent/messages";
import { readLines, replay } from "@vibevalley/agent/session";
import type { ModelClient } from "@vibevalley/ai/client";
import type { Usage } from "@vibevalley/ai/messages";
import { t } from "@vibevalley/i18n";
import type { OrchestratorState } from "@vibevalley/protocol";

import { newId } from "@/base/ids.ts";
import { messageOf, type ApiError, missing, refused } from "@/errors.ts";

import { AgentExecution, type RunInput } from "./execution.ts";
import type { ToolStart } from "./facts.ts";
import type { Journal } from "./journal.ts";
import type { RunStore } from "./session.ts";
import { tokensOf, usageText } from "./usage.ts";

/** One answer streamed to a caller (a call's line, a chat/completions request, a brief). A newer one ends the one before.
 * Its words are read once: what came before the reader is kept for it. */
export class Caller {
  private kept: string[] = [];
  private ended = false;
  private failure: Cause.Cause<unknown> | undefined;
  private reader: Queue.Queue<string, unknown> | undefined;

  push(text: string) {
    if (this.ended) return;
    if (this.reader) Queue.offerUnsafe(this.reader, text);
    else this.kept.push(text);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    if (this.reader) Queue.endUnsafe(this.reader);
  }

  fail(error: unknown) {
    if (this.ended) return;
    this.failure = Cause.fail(error);
    this.ended = true;
    if (this.reader) Queue.failCauseUnsafe(this.reader, this.failure);
  }

  readonly words: Stream.Stream<string, unknown> = Stream.callback<string, unknown>((queue) =>
    Effect.sync(() => {
      for (const w of this.kept) Queue.offerUnsafe(queue, w);
      this.kept = [];
      if (this.failure) Queue.failCauseUnsafe(queue, this.failure);
      else if (this.ended) Queue.endUnsafe(queue);
      else this.reader = queue;
    }),
  );
}

/** Why the agent did not start: the model missing a key, or the host closing. The message is what the owner reads. */
class CannotStart extends Data.TaggedError("CannotStart")<{ readonly message: string }> {}

/** An input as the host keeps it: its route (kept in the transcript), and in process only the run it starts and the
 * caller waiting on its words. */
export interface Hosted<R> {
  readonly route: R;
  readonly run: RunInput;
  readonly caller?: Caller;
}

export interface HostOptions<R> {
  /** Its id: its transcript's and log's name. */
  readonly name: string;
  /** How the owner calls it, in what the host says. */
  readonly label: string;
  /** The custom message type its inputs are kept under in its transcript. */
  readonly inputType: string;
  readonly home: string;
  readonly cwd: string;
  readonly instructions: string;
  /** Asked when the agent starts: a model missing a key throws, and the input that started it says why. */
  readonly llm: () => ModelClient;
  /** The tools; each reads the route of the input taken last. */
  readonly tools: (current: () => R) => Tool[];
  readonly wakeSoon?: (withinMs: number) => boolean;
  /** The route before any input is taken. */
  readonly first: R;
  /** Words are not said for this route (the caller still gets them). */
  readonly quiet: (route: R) => boolean;
  /** Where words go: each of the model's answers in full, as one message; the caller has them as they grow. */
  readonly say: (route: R, text: string, run: string) => Effect.Effect<void, unknown>;
  /** route: the input it works for, once it has taken one in this run; its words go there. */
  readonly state: (state: OrchestratorState, route?: R) => Effect.Effect<void, unknown>;
  /** The agent started, or folded its conversation: what the model saw before is gone from it. */
  readonly fresh: () => void;
  /** The run an input found in the transcript after a restart goes on with: its issue and trigger, from its route. */
  readonly restored: (route: R) => RunInput;
  /** How many events its log keeps; 0 keeps them all. */
  readonly keepEvents?: number;
  readonly toolStart: (tool: string, args: unknown) => ToolStart;
  readonly notice: (level: "info" | "warn" | "error", text: string) => Effect.Effect<void>;
}

/** What makes an input's text once it is its turn: whether the agent is busy (an input may be taken after a later one),
 * and what memory gained since the model last saw it. heard: the messages the text tells of, recorded on the run. */
export type Build = (busy: boolean, memoryNews: string) => Effect.Effect<{ readonly text: string; readonly heard?: readonly string[] }, unknown>;

export type Submitted = { readonly ok: true } | { readonly ok: false; readonly why: string; readonly run: string };

export interface AgentHost<R> {
  /** The input taken last: its route is where words go now. */
  readonly current: () => Hosted<R>;
  /** The run a restart cut off is in the transcript. */
  readonly unfinished: () => boolean;
  /** now joins the run under way; otherwise the input waits until the run would stop. false and why when the agent
   * cannot start: that input is recorded as a failed run of its own. */
  readonly submit: (build: Build, input: Hosted<R>, now: boolean) => Effect.Effect<Submitted, unknown>;
  /** The run the last start was cut off in goes on, with the input it was taking, within maxAgeMs. */
  readonly resume: (maxAgeMs: number) => Effect.Effect<void>;
  /** The inputs waiting are dropped with the run. */
  readonly stop: Effect.Effect<void>;
  /** Waits for the input being built, closes the agent and follows its last events; every call waits for the one close. */
  readonly close: Effect.Effect<void>;
  /** The turn that took step on of the log, kept as an eval case with what it should have done. */
  readonly markWrong: (on: number, want: string, model: string, tools: readonly string[]) => Effect.Effect<{ id: string; file: string }, ApiError>;
}

/** Made by Sessions.host in the owner's scope: the agent's own scope is a child of it, so the agent ends with the owner at
 * the latest; its log and its runs are kept with the sessions'. */
export const makeHost = <R>(o: HostOptions<R>, journal: Journal, runs: RunStore): Effect.Effect<AgentHost<R>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const owner = yield* Effect.scope;
    const execution = new AgentExecution(o.name, journal, o.toolStart, runs);
    const transcript = join(o.home, o.name + ".jsonl");
    const local = new WeakMap<BrainMessage, Hosted<R>>();
    let input: Hosted<R> = { route: o.first, run: { by: { kind: "" } } };
    let toCaller = 0;
    /** An answer is being written: its words have begun and it is not yet said. */
    let open = false;
    let prefixChanged: string[] = [];
    let closing = false;
    const closed = yield* Deferred.make<void>();
    let brain: { readonly brain: Brain; readonly scope: Scope.Closeable; readonly following: Fiber.Fiber<void> } | undefined;
    /** Held from building an input to handing it over, so that each input's text follows the one before. */
    const inputs = yield* Semaphore.make(1);
    const stopped = () => t("server.session.host.stopped", { label: o.label });
    const log = (text: string) => Effect.logError(`vibevalley: ${o.name}: ${text}`);

    const current = (): Hosted<R> => {
      const messages = brain?.brain.history() ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a custom message of this host's input type carries the route this host put in it
        if (isHosted(m, o.inputType)) return local.get(m) ?? { route: m.details as R, run: { by: { kind: "" } } };
      }
      return input;
    };

    const closeInput = (hosted: Hosted<R>): Submitted => {
      hosted.caller?.end();
      return { ok: false, why: stopped(), run: "" };
    };

    // The caller (a call's line, the local chat/completions) gets the words as they grow; the chat gets the answer once
    // it is whole, and meanwhile only that it is being written.
    const grow = (text: string) =>
      Effect.suspend(() => {
        const at = input;
        if (at.caller && text.length > toCaller) {
          at.caller.push(text.slice(toCaller));
          toCaller = text.length;
        }
        if (open) return Effect.void;
        open = true;
        return o.state("speaking", at.route);
      });

    const done = (text: string) =>
      Effect.gen(function* () {
        const at = input;
        if (at.caller && text.length > toCaller) at.caller.push(text.slice(toCaller));
        if (at.caller && text) at.caller.push("\n");
        toCaller = 0;
        const wrote = open;
        open = false;
        if (text && !o.quiet(at.route)) yield* o.say(at.route, text, execution.currentRun());
        // The run goes on (its tools, another answer) until it settles.
        if (wrote) yield* o.state("thinking", at.route);
      });

    // Only stop aborts a run while the farm is up; the settle close publishes is the farm stopping.
    const settled = (aborted: boolean) =>
      Effect.suspend(() => {
        if (aborted && !closing) journal.note("run/error", t("server.session.log.stoppedByOwner"));
        input.caller?.end();
        input = { route: input.route, run: input.run };
        open = false;
        return o.state("listening");
      });

    // An answer that failed before any token came has none to tell.
    const noteUsage = (u: Usage | undefined) => {
      if (!u || (u.input === 0 && u.cacheRead === 0 && u.output === 0)) return;
      const changed = prefixChanged;
      prefixChanged = [];
      const tokens = tokensOf(u);
      journal.usage(tokens, usageText(tokens, changed));
    };

    const event = (e: BrainEvent): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        let run: RunInput | undefined;
        if (e.type === "message_start" && isHosted(e.message, o.inputType)) run = local.get(e.message)?.run ?? { by: { kind: "" } };
        if (
          e.type !== "agent_settled" &&
          e.type !== "compaction_start" &&
          e.type !== "compaction_end" &&
          e.type !== "prefix_changed" &&
          e.type !== "tasks_changed"
        )
          yield* execution
            .observe(e, run)
            .pipe(Effect.catch((err) => o.notice("error", t("server.session.host.notRecorded", { label: o.label, why: err.message }))));
        switch (e.type) {
          case "message_start":
            if (isHosted(e.message, o.inputType)) {
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a custom message of this host's input type carries the route this host put in it
              const next = local.get(e.message) ?? { route: e.message.details as R, run: { by: { kind: "" } } };
              // An input that joins the run takes the words from here on: the one before has what it got, and ends now, or a
              // caller waiting on it (a brief, a call's line) would wait for the run's end with no words.
              if (input.caller && input.caller !== next.caller) input.caller.end();
              input = next;
              toCaller = 0;
              // It works for this input from here on, wherever the run began.
              yield* o.state("thinking", next.route);
            }
            return;
          case "agent_start":
            // The input it starts on is taken next (message_start), and says where.
            return yield* o.state("thinking");
          case "message_update": {
            if (e.message.role !== "assistant") return;
            const text = messageText(e.message);
            if (text) yield* grow(text);
            return;
          }
          case "message_end": {
            if (e.message.role !== "assistant") return;
            const m = e.message;
            noteUsage(m.usage);
            yield* done(messageText(m).trim());
            if (m.stopReason === "error")
              yield* o.notice("error", t("server.session.host.failed", { label: o.label, why: m.errorMessage || t("server.agent.modelFailed") }));
            return;
          }
          case "compaction_end":
            if (e.usage) {
              const tokens = tokensOf(e.usage);
              journal.usage(tokens, t("server.session.log.folded", { usage: usageText(tokens) }));
            }
            if (e.compaction) o.fresh();
            return;
          case "prefix_changed":
            yield* Effect.logInfo(`vibevalley: ${o.name}'s prompt start changed between compactions: ${e.parts.join(",")}`);
            prefixChanged = e.parts;
            return;
          case "agent_settled":
            return yield* settled(e.run.aborted);
          default:
            return;
        }
      });

    // Started on first use: loading it is not free, and a farm without a model works otherwise. Only ever under inputs.
    const start = Effect.gen(function* () {
      if (brain) return brain.brain;
      if (closing) return yield* new CannotStart({ message: stopped() });
      const llm = yield* Effect.try({ try: o.llm, catch: (e) => new CannotStart({ message: messageOf(e) }) });
      const scope = yield* Scope.fork(owner);
      // The brain publishes on its own fibers and waits for its listeners: its events go through a queue, followed one
      // at a time in order, so that the brain waits for none of what they start. The queue ends after the brain's own
      // close (finalizers run last first), which still publishes the run's end.
      const events = yield* Queue.unbounded<BrainEvent, Cause.Done>();
      yield* Scope.addFinalizer(scope, Queue.end(events));
      const made = yield* Brain.make({
        name: o.name,
        instructions: o.instructions,
        llm,
        home: o.home,
        cwd: o.cwd,
        tools: o.tools(() => current().route),
        noSkills: true,
        noSubagents: true,
        reminders: false,
        ...(o.wakeSoon ? { wakeSoon: o.wakeSoon } : {}),
      }).pipe(
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      o.fresh();
      made.subscribe((e) => Effect.sync(() => void Queue.offerUnsafe(events, e)));
      const following = yield* Stream.fromQueue(events).pipe(
        Stream.runForEach((e) => event(e).pipe(Effect.catchCause((c) => log(`could not follow its agent: ${Cause.pretty(c)}`)))),
        Effect.forkIn(owner),
      );
      yield* Effect.logInfo(`vibevalley: ${o.name} is on vibevalley's own agent, model ${llm.model.id}`);
      brain = { brain: made, scope, following };
      return made;
    });

    const submit = (build: Build, hosted: Hosted<R>, now: boolean): Effect.Effect<Submitted, unknown> =>
      Effect.suspend(() => {
        if (closing) return Effect.succeed(closeInput(hosted));
        const run: RunInput = { ...hosted.run, by: hosted.run.by.kind ? hosted.run.by : { kind: "comment" } };
        return inputs.withPermits(1)(
          Effect.gen(function* () {
            const started = yield* Effect.result(start);
            if (started._tag === "Failure") {
              if (closing) return closeInput(hosted);
              const why = messageOf(started.failure);
              const id = yield* execution
                .failedStart(run, hosted.run.asked ?? "", t("server.session.host.cannotStart", { why }))
                .pipe(Effect.catch((e) => Effect.as(o.notice("error", t("server.session.host.notRecorded", { label: o.label, why: e.message })), "")));
              yield* o.notice("error", t("server.session.host.startFailed", { label: o.label, why }));
              hosted.caller?.push(t("server.session.host.callerStart", { why }));
              hosted.caller?.end();
              return { ok: false, why, run: id } as const;
            }
            const b = started.success;
            if (closing) return closeInput(hosted);
            const { text, heard } = yield* build(b.busy() || (yield* b.queued()), b.memoryNews());
            if (closing) return closeInput(hosted);
            const message = customMessage(o.inputType, text, yield* Clock.currentTimeMillis, { details: hosted.route });
            local.set(message, { ...hosted, run: { ...run, ...(heard ? { heard } : {}) } });
            yield* now ? b.send(message) : b.later(message);
            return { ok: true } as const;
          }),
        );
      });

    const resume = (maxAgeMs: number) =>
      inputs.withPermits(1)(
        Effect.gen(function* () {
          if (closing) return;
          const started = yield* Effect.result(start);
          if (started._tag === "Failure") {
            if (!closing) yield* log(`could not go on with its last run: ${messageOf(started.failure)}`);
            return;
          }
          const b = started.success;
          if (closing) return;
          const at = current();
          input = at;
          toCaller = 0;
          execution.resume(o.restored(at.route));
          if (yield* b.resume(maxAgeMs)) return;
          execution.resume(undefined);
          if (!b.busy()) journal.note("run/error", t("server.session.log.staleRun"));
        }),
      );

    const closeOnce = Effect.gen(function* () {
      // The input being built finishes first (and is not delivered), then the agent closes and its last events are followed.
      yield* inputs.withPermits(1)(Effect.void);
      const b = brain;
      if (b) {
        yield* Scope.close(b.scope, Exit.void);
        yield* Fiber.await(b.following);
      }
      yield* execution.close().pipe(Effect.catch((err) => log(`execution: ${err.message}`)));
    });

    const close = Effect.suspend(() => {
      if (closing) return Deferred.await(closed);
      closing = true;
      return closeOnce.pipe(Effect.ensuring(Deferred.done(closed, Exit.void)), Effect.andThen(Deferred.await(closed)));
    });

    const markWrong = (on: number, want: string, model: string, tools: readonly string[]) =>
      Effect.gen(function* () {
        const w = want.trim();
        if (!w) return yield* Effect.fail(refused(t("server.session.host.markNeedsWords")));
        const asked = journal.events().find((e) => e.seq === on);
        if (!asked) return yield* Effect.fail(missing(t("server.session.host.noStep", { label: o.label, on }), [{ say: t("server.session.host.stepHint") }]));
        if (asked.type !== "user/message") return yield* Effect.fail(refused(t("server.session.host.notAsked", { on, label: o.label })));
        const lines = readLines(transcript);
        const at = turnAt(lines, asked.text, asked.time, o.inputType);
        if (at < 0) return yield* Effect.fail(refused(t("server.session.host.notInConversation", { on, label: o.label })));
        const memoryText = yield* Effect.try(() => readFileSync(memoryFile(o.home), "utf8")).pipe(Effect.orElseSucceed(() => ""));
        const id = newId();
        const evalCase = {
          id,
          createdAt: yield* Clock.currentTimeMillis,
          model,
          want: w,
          memory: memoryText,
          tools,
          before: replay(lines.slice(0, at)),
          input: lines[at],
          did: turnOf(lines.slice(at + 1), o.inputType),
          expect: [],
        };
        const file = join(o.home, "evals", id + ".json");
        yield* Effect.try({
          try: () => {
            mkdirSync(join(o.home, "evals"), { recursive: true });
            writeFileSync(file, JSON.stringify(evalCase, null, 2) + "\n", { mode: 0o600 });
          },
          catch: (err) => refused(messageOf(err)),
        });
        return { id, file };
      });

    return {
      current,
      unfinished: () => sessionUnfinished(transcript),
      submit,
      resume,
      stop: Effect.suspend(() => brain?.brain.stop() ?? Effect.void),
      close,
      markWrong,
    };
  });

const isHosted = (m: BrainMessage, inputType: string): m is CustomMessage => m.role === "custom" && m.customType === inputType;

/** The input that began the turn asked: logged when the input is taken, after it was made, so the message is no newer
 * than the step, and it holds the step's words (trimmed and maybe cut; the message puts what the owner adds before them).
 * Of those, the newest: an older one with the same words was taken before. -1 when none is. */
export function turnAt(lines: readonly BrainMessage[], text: string, time: number, inputType: string): number {
  const head = text.endsWith("…") ? text.slice(0, -1) : text;
  let at = -1;
  lines.forEach((m, i) => {
    if (isHosted(m, inputType) && m.timestamp <= time && messageText(m).includes(head) && (at < 0 || m.timestamp >= lines[at]!.timestamp)) at = i;
  });
  return at;
}

/** What followed an input until the next one, without the compactions written after a run. */
export function turnOf(rest: readonly BrainMessage[], inputType: string): BrainMessage[] {
  const out: BrainMessage[] = [];
  for (const m of rest) {
    if (isHosted(m, inputType)) break;
    if (m.role !== "compactionSummary") out.push(m);
  }
  return out;
}
