import { join } from "node:path";

import { Cause, Clock, Deferred, Effect, Exit, Fiber, FileSystem, Queue, Schema, Scope, Semaphore, Stream } from "effect";

import { type Brain, type BrainEvent, makeBrain, sessionUnfinished } from "@vibevalley/agent/brain";
import type { Tool } from "@vibevalley/agent/core/loop";
import { type MemoryPort } from "@vibevalley/agent/memory";
import { type BrainMessage, type CustomMessage, customMessage, messageText } from "@vibevalley/agent/messages";
import { readLines, replay } from "@vibevalley/agent/session";
import type { ModelClient } from "@vibevalley/ai/client";
import type { Usage } from "@vibevalley/ai/messages";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { messageOf, type ApiError, missing, refused } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { Core } from "#/core/core.ts";

import { makeInProcessRun, type RunInput } from "./inProcessRun.ts";
import type { Journal } from "./journal.ts";
import type { ToolStart } from "./reaction.ts";
import { tokensOf, usageText } from "./report.ts";
import type { RunStore } from "./session.ts";
import type { SessionIdentity } from "./signals.ts";

/** The input a caller waited on was not taken; cause is whatever stopped it, a defect included. */
export class NotAnswered extends Schema.TaggedError<NotAnswered, { readonly brand: unique symbol }>()("NotAnswered", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** One answer streamed to a caller (a call's line, a chat/completions request, a brief). A newer one ends the one before. */
export class Caller {
  private kept: string[] = [];
  private ended = false;
  private failure: Cause.Cause<NotAnswered> | undefined;
  private reader: Queue.Queue<string, NotAnswered | Cause.Done> | undefined;

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

  fail(cause: unknown) {
    if (this.ended) return;
    this.failure = Cause.fail(new NotAnswered({ message: messageOf(cause), cause }));
    this.ended = true;
    if (this.reader) Queue.failCauseUnsafe(this.reader, this.failure);
  }

  readonly words: Stream.Stream<string, NotAnswered> = Stream.callback<string, NotAnswered>((queue) =>
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
class CannotStart extends Schema.TaggedError<CannotStart, { readonly brand: unique symbol }>()("CannotStart", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** An input as the host keeps it: its route (kept in the transcript), and in process only the run it starts and the
 * caller waiting on its words. */
export interface Hosted<R> {
  readonly route: R;
  readonly run: RunInput;
  readonly caller?: Caller;
}

export interface HostOptions<R> {
  readonly session: SessionIdentity;
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
  readonly say: (route: R, text: string, run: string) => Effect.Effect<void>;
  /** route: the input it works for, once it has taken one in this run; its words go there. */
  readonly channel: (route: R) => string | undefined;
  /** The agent started, or folded its conversation: what the model saw before is gone from it. */
  readonly fresh: () => void;
  /** The run an input found in the transcript after a restart goes on with: its issue and trigger, from its route. */
  readonly restored: (route: R) => RunInput;
  /** How many events its log keeps; 0 keeps them all. */
  readonly keepEvents?: number;
  readonly toolStart: (tool: string, args: unknown) => ToolStart;
}

/** What makes an input's text once it is its turn. heard: the messages the text tells of, recorded on the run. */
export type Build<E> = (busy: boolean, memoryNews: string) => Effect.Effect<{ readonly text: string; readonly heard?: readonly string[] }, E>;

type Submitted = { readonly ok: true } | { readonly ok: false; readonly why: string; readonly run: string };

export interface AgentHost<R> {
  /** The input taken last: its route is where words go now. */
  readonly current: () => Hosted<R>;
  /** The run a restart cut off is in the transcript. */
  readonly unfinished: Effect.Effect<boolean>;
  /** now joins the run under way. otherwise the input waits until the run would stop. */
  readonly submit: <E>(build: Build<E>, input: Hosted<R>, now: boolean) => Effect.Effect<Submitted, E>;
  /** The run the last start was cut off in goes on, with the input it was taking, within maxAgeMs. */
  readonly resume: (maxAgeMs: number) => Effect.Effect<void>;
  /** The inputs waiting are dropped with the run. */
  readonly stop: Effect.Effect<void>;
  /** Waits for the input being built, closes the agent and follows its last events; every call waits for the one close. */
  readonly close: Effect.Effect<void>;
  /** The turn that took step on of the log, kept as an eval case with what it should have done. */
  readonly markWrong: (on: number, want: string, model: string, tools: readonly string[]) => Effect.Effect<{ id: string; file: string }, ApiError>;
}

/** Made by Session.host in the owner's scope: the agent's own scope is a child of it, so the agent ends with the owner at the latest. */
export const makeHost = <R>(
  o: HostOptions<R> & { readonly memory: MemoryPort },
  journal: Journal,
  runs: RunStore,
): Effect.Effect<AgentHost<R>, never, Scope.Scope | Core | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const core = yield* Core;
    const fs = yield* FileSystem.FileSystem;
    const owner = yield* Effect.scope;
    const inProcess = yield* makeInProcessRun(o.session.id, journal, o.toolStart, runs);
    const transcript = join(o.home, o.session.id + ".jsonl");
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
    const stopped = () => t("server.session.host.stopped", { label: o.session.name });
    /** Every line this host logs says whose it is. */
    const own = Effect.annotateLogs({ agent: o.session.id });
    const log = (text: string) => own(Effect.logError(`vibevalley: ${text}`));

    const current = (): Hosted<R> => {
      const messages = brain?.brain.history() ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a custom message of this host's input type carries the route this host put in it
        if (m && isHosted(m, o.inputType)) return local.get(m) ?? { route: m.details as R, run: { by: { kind: "" } } };
      }
      return input;
    };

    const closeInput = (hosted: Hosted<R>): Submitted => {
      hosted.caller?.end();
      return { ok: false, why: stopped(), run: "" };
    };

    // The caller (a call's line, the local chat/completions) gets the words as they grow.
    const activity = Effect.fn("Session.activity")(function* (action: T.SessionAction, route?: R) {
      const id = sessionId(o.session.id);
      const session = core.session(id);
      if (!session) return;
      const phase = session.phase;
      const channel = route === undefined ? undefined : o.channel(route);
      yield* core.apply({
        type: "sessionPhaseChanged",
        id,
        phase: { _tag: "working", since: phase._tag === "working" ? phase.since : yield* Clock.currentTimeMillis, doing: { action, label: "" } },
        ...(channel === undefined ? {} : { channel }),
      });
    });

    const grow = (text: string) =>
      Effect.suspend(() => {
        const at = input;
        if (at.caller && text.length > toCaller) {
          at.caller.push(text.slice(toCaller));
          toCaller = text.length;
        }
        if (open) return Effect.void;
        open = true;
        return activity("speaking_text", at.route);
      });

    const done = (text: string) =>
      Effect.gen(function* () {
        const at = input;
        if (at.caller && text.length > toCaller) at.caller.push(text.slice(toCaller));
        if (at.caller && text) at.caller.push("\n");
        toCaller = 0;
        const wrote = open;
        open = false;
        if (text && !o.quiet(at.route)) yield* o.say(at.route, text, inProcess.currentRun());
        // The run goes on (its tools, another answer) until it settles.
        if (wrote) yield* activity("thinking", at.route);
      });

    // Only stop aborts a run while the farm is up; the settle close publishes is the farm stopping.
    const settled = (aborted: boolean) =>
      Effect.suspend(() => {
        if (aborted && !closing) journal.note("run/error", t("server.session.log.stoppedByOwner"));
        input.caller?.end();
        input = { route: input.route, run: input.run };
        open = false;
        return Effect.void;
      });

    // An answer that failed before any token came has none to tell.
    const noteUsage = (u: Usage | undefined) => {
      if (!u || (u.input === 0 && u.cacheRead === 0 && u.output === 0)) return;
      const changed = prefixChanged;
      prefixChanged = [];
      const tokens = tokensOf(u);
      journal.usage(tokens, usageText(tokens, changed));
    };

    const event = (e: BrainEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        let run: RunInput | undefined;
        if (e.type === "message_start" && isHosted(e.message, o.inputType)) run = local.get(e.message)?.run ?? { by: { kind: "" } };
        if (
          e.type !== "agent_settled" &&
          e.type !== "compaction_start" &&
          e.type !== "compaction_end" &&
          e.type !== "prefix_changed" &&
          e.type !== "todos_changed" &&
          e.type !== "agent_closed"
        )
          yield* inProcess
            .observe(e, run)
            .pipe(Effect.catch((err) => core.notice("error", t("server.session.host.notRecorded", { label: o.session.name, why: err.message }))));
        switch (e.type) {
          case "message_start":
            if (isHosted(e.message, o.inputType)) {
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a custom message of this host's input type carries the route this host put in it
              const next = local.get(e.message) ?? { route: e.message.details as R, run: { by: { kind: "" } } };
              // An input that joins the run takes the words from here on.
              if (input.caller && input.caller !== next.caller) input.caller.end();
              input = next;
              toCaller = 0;
              // It works for this input from here on, wherever the run began.
              yield* activity("thinking", next.route);
            }
            return;
          case "agent_start":
            // The input it starts on is taken next (message_start), and says where.
            return yield* activity("thinking");
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
              yield* core.notice("error", t("server.session.host.failed", { label: o.session.name, why: m.errorMessage || t("server.agent.modelFailed") }));
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
            yield* Effect.logInfo(`vibevalley: the prompt start changed between compactions: ${e.parts.join(",")}`);
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
      const llm = yield* Effect.try({ try: o.llm, catch: (e) => new CannotStart({ message: messageOf(e), cause: e }) });
      const scope = yield* Scope.fork(owner);
      const made = yield* makeBrain({
        name: o.session.id,
        instructions: o.instructions,
        memory: o.memory,
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
      // Followed one at a time in order, on the owner's fibers, so the brain waits for none of what they start.
      const events = yield* Scope.provide(made.events, owner);
      const following = yield* events.pipe(
        Stream.runForEach((e) => event(e).pipe(Effect.catchCause((c) => log(`could not follow its agent: ${Cause.pretty(c)}`)))),
        own,
        Effect.forkIn(owner),
      );
      yield* own(Effect.logInfo(`vibevalley: on vibevalley's own agent, model ${llm.model.id}`));
      brain = { brain: made, scope, following };
      return made;
    });

    const submit = <E>(build: Build<E>, hosted: Hosted<R>, now: boolean): Effect.Effect<Submitted, E> =>
      Effect.suspend(() => {
        if (closing) return Effect.succeed(closeInput(hosted));
        const run: RunInput = { ...hosted.run, by: hosted.run.by.kind ? hosted.run.by : { kind: "comment" } };
        return inputs.withPermits(1)(
          Effect.matchEffect(start, {
            onFailure: (err) =>
              Effect.gen(function* () {
                if (closing) return closeInput(hosted);
                const why = messageOf(err);
                const id = yield* inProcess
                  .failedStart(run, hosted.run.asked ?? "", t("server.session.host.cannotStart", { why }))
                  .pipe(
                    Effect.catch((e) => Effect.as(core.notice("error", t("server.session.host.notRecorded", { label: o.session.name, why: e.message })), "")),
                  );
                yield* core.notice("error", t("server.session.host.startFailed", { label: o.session.name, why }));
                hosted.caller?.push(t("server.session.host.callerStart", { why }));
                hosted.caller?.end();
                return { ok: false, why, run: id } as const;
              }),
            onSuccess: (b) =>
              Effect.gen(function* () {
                if (closing) return closeInput(hosted);
                const { text, heard } = yield* build(b.busy() || (yield* b.queued), yield* b.memoryNews);
                if (closing) return closeInput(hosted);
                const message = customMessage(o.inputType, text, yield* Clock.currentTimeMillis, { details: hosted.route });
                local.set(message, { ...hosted, run: { ...run, ...(heard ? { heard } : {}) } });
                yield* now ? b.send(message) : b.later(message);
                return { ok: true } as const;
              }),
          }),
        );
      });

    const resume = (maxAgeMs: number) =>
      inputs.withPermits(1)(
        Effect.gen(function* () {
          if (closing) return;
          const b = yield* start.pipe(
            Effect.catch((e) => Effect.as(!closing ? log(`could not go on with its last run: ${messageOf(e)}`) : Effect.void, undefined)),
          );
          if (!b || closing) return;
          const at = current();
          input = at;
          toCaller = 0;
          inProcess.resume(o.restored(at.route));
          if (yield* b.resume(maxAgeMs)) return;
          inProcess.resume(undefined);
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
      yield* inProcess.close.pipe(Effect.catch((err) => log(`in-process run: ${err.message}`)));
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
        if (!asked)
          return yield* Effect.fail(missing(t("server.session.host.noStep", { label: o.session.name, on }), [{ say: t("server.session.host.stepHint") }]));
        if (asked.type !== "user/message") return yield* Effect.fail(refused(t("server.session.host.notAsked", { on, label: o.session.name })));
        const lines = yield* Effect.promise(() => readLines(transcript));
        const at = turnAt(lines, asked.text, asked.time, o.inputType);
        if (at < 0) return yield* Effect.fail(refused(t("server.session.host.notInConversation", { on, label: o.session.name })));
        const memoryText = yield* Effect.mapBoth(o.memory.read(), {
          onFailure: (e) => refused(messageOf(e)),
          onSuccess: (read) => read.prompt,
        });
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
        yield* fs.makeDirectory(join(o.home, "evals"), { recursive: true }).pipe(Effect.mapError((err) => refused(messageOf(err))));
        yield* fs.writeFileString(file, JSON.stringify(evalCase, null, 2) + "\n", { mode: 0o600 }).pipe(Effect.mapError((err) => refused(messageOf(err))));
        return { id, file };
      });

    return {
      current,
      unfinished: Effect.promise(() => sessionUnfinished(transcript)),
      submit,
      resume,
      stop: Effect.suspend(() => brain?.brain.stop ?? Effect.void),
      close,
      markWrong,
    };
  });

const isHosted = (m: BrainMessage, inputType: string): m is CustomMessage => m.role === "custom" && m.customType === inputType;

/** The input that began the turn asked. the message puts what the owner adds before them). */
function turnAt(lines: readonly BrainMessage[], text: string, time: number, inputType: string): number {
  const head = text.endsWith("…") ? text.slice(0, -1) : text;
  let at = -1;
  lines.forEach((m, i) => {
    const prev = lines[at];
    if (isHosted(m, inputType) && m.timestamp <= time && messageText(m).includes(head) && (!prev || m.timestamp >= prev.timestamp)) at = i;
  });
  return at;
}

/** What followed an input until the next one, without the compactions written after a run. */
function turnOf(rest: readonly BrainMessage[], inputType: string): BrainMessage[] {
  const out: BrainMessage[] = [];
  for (const m of rest) {
    if (isHosted(m, inputType)) break;
    if (m.role !== "compactionSummary") out.push(m);
  }
  return out;
}
