import { join } from "node:path";

import { Cause, Clock, Effect, Exit, Fiber, FileSystem, Queue, Schema, Scope, Semaphore, Stream } from "effect";

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

export class NotAnswered extends Schema.TaggedError<NotAnswered, { readonly brand: unique symbol }>()("NotAnswered", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

type CallerState =
  | { readonly _tag: "buffering"; readonly kept: string[] }
  | { readonly _tag: "streaming"; readonly reader: Queue.Queue<string, NotAnswered | Cause.Done> }
  | { readonly _tag: "ended"; readonly kept: readonly string[] }
  | { readonly _tag: "failed"; readonly kept: readonly string[]; readonly failure: Cause.Cause<NotAnswered> };

/** Streams one turn's text to an in-process caller; superseded when a newer input joins the run. */
export class Caller {
  private state: CallerState = { _tag: "buffering", kept: [] };

  push(text: string) {
    switch (this.state._tag) {
      case "buffering":
        this.state.kept.push(text);
        return;
      case "streaming":
        Queue.offerUnsafe(this.state.reader, text);
        return;
      case "ended":
      case "failed":
        return;
    }
  }

  end() {
    switch (this.state._tag) {
      case "buffering":
        this.state = { _tag: "ended", kept: this.state.kept };
        return;
      case "streaming":
        Queue.endUnsafe(this.state.reader);
        this.state = { _tag: "ended", kept: [] };
        return;
      case "ended":
      case "failed":
        return;
    }
  }

  fail(cause: unknown) {
    const failure = Cause.fail(NotAnswered.make({ message: messageOf(cause), cause }));
    switch (this.state._tag) {
      case "buffering":
        this.state = { _tag: "failed", kept: this.state.kept, failure };
        return;
      case "streaming":
        Queue.failCauseUnsafe(this.state.reader, failure);
        this.state = { _tag: "failed", kept: [], failure };
        return;
      case "ended":
      case "failed":
        return;
    }
  }

  readonly words: Stream.Stream<string, NotAnswered> = Stream.callback<string, NotAnswered>((queue) =>
    Effect.sync(() => {
      switch (this.state._tag) {
        case "buffering":
          for (const w of this.state.kept) Queue.offerUnsafe(queue, w);
          this.state = { _tag: "streaming", reader: queue };
          return;
        case "ended":
          for (const w of this.state.kept) Queue.offerUnsafe(queue, w);
          this.state = { _tag: "ended", kept: [] };
          Queue.endUnsafe(queue);
          return;
        case "failed":
          for (const w of this.state.kept) Queue.offerUnsafe(queue, w);
          Queue.failCauseUnsafe(queue, this.state.failure);
          this.state = { _tag: "failed", kept: [], failure: this.state.failure };
          return;
        case "streaming":
          this.state = { _tag: "streaming", reader: queue };
          return;
      }
    }),
  );
}

class CannotStart extends Schema.TaggedError<CannotStart, { readonly brand: unique symbol }>()("CannotStart", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface Hosted<R> {
  readonly route: R;
  readonly run: RunInput;
  readonly caller?: Caller;
}

export interface HostOptions<R> {
  readonly session: SessionIdentity;
  readonly inputType: string;
  readonly home: string;
  readonly cwd: string;
  readonly instructions: string;
  /** Invoked lazily on first input; throws when the model key is missing. */
  readonly llm: () => ModelClient;
  readonly tools: (current: () => R) => Tool[];
  readonly skills?: readonly string[];
  readonly wakeSoon?: (withinMs: number) => boolean;
  readonly first: R;
  /** Suppresses `say` while still streaming tokens to `caller`. */
  readonly quiet: (route: R) => boolean;
  readonly say: (route: R, text: string, run: string) => Effect.Effect<void>;
  readonly channel: (route: R) => string | undefined;
  /** Invoked when the brain starts or compacts so stale prompt state can be reset. */
  readonly fresh: () => void;
  readonly restored: (route: R) => RunInput;
  /** 0 retains all events. */
  readonly keepEvents?: number;
  readonly toolStart: (tool: string, args: unknown) => ToolStart;
}

export type Build<E> = (busy: boolean, memoryNews: string) => Effect.Effect<{ readonly text: string; readonly heard?: readonly string[] }, E>;

type Submitted = { readonly ok: true } | { readonly ok: false; readonly why: string; readonly run: string };

export interface AgentHost<R> {
  readonly current: () => Hosted<R>;
  readonly unfinished: Effect.Effect<boolean>;
  /** `now: true` steers into the active run; `false` queues until the active run settles. */
  readonly submit: <E>(build: Build<E>, input: Hosted<R>, now: boolean) => Effect.Effect<Submitted, E>;
  readonly resume: (maxAgeMs: number) => Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  readonly markWrong: (on: number, want: string, model: string, tools: readonly string[]) => Effect.Effect<{ id: string; file: string }, ApiError>;
}

const encodePretty = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

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
    let open = false;
    let prefixChanged: string[] = [];
    let closing = false;
    let closer: Fiber.Fiber<void> | undefined;
    let brain: { readonly brain: Brain; readonly scope: Scope.Closeable; readonly following: Fiber.Fiber<void> } | undefined;
    // Serializes input construction and brain delivery so transcript entries preserve arrival order.
    const inputs = yield* Semaphore.make(1);
    const stopped = () => t("server.session.host.stopped", { label: o.session.name });
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
        if (wrote) yield* activity("thinking", at.route);
      });

    const settled = (aborted: boolean) =>
      Effect.suspend(() => {
        if (aborted && !closing) journal.note("run/error", t("server.session.log.stoppedByUser"));
        input.caller?.end();
        input = { route: input.route, run: input.run };
        open = false;
        return Effect.void;
      });

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
              if (input.caller && input.caller !== next.caller) input.caller.end();
              input = next;
              toCaller = 0;
              yield* activity("thinking", next.route);
            }
            return;
          case "agent_start":
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

    // Lazily initialized under `inputs` semaphore so startup succeeds even before model keys are configured.
    const start = Effect.gen(function* () {
      if (brain) return brain.brain;
      if (closing) return yield* CannotStart.make({ message: stopped() });
      const llm = yield* Effect.try({ try: o.llm, catch: (e) => CannotStart.make({ message: messageOf(e), cause: e }) });
      const scope = yield* Scope.fork(owner);
      const made = yield* makeBrain({
        name: o.session.id,
        instructions: o.instructions,
        memory: o.memory,
        llm,
        home: o.home,
        cwd: o.cwd,
        tools: o.tools(() => current().route),
        ...(o.skills === undefined ? { noSkills: true } : { skills: o.skills }),
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
                const busy = b.busy() || (yield* b.queued);
                const memoryNews = yield* b.memoryNews;
                const { text, heard } = yield* build(busy, memoryNews);
                if (closing) return closeInput(hosted);
                const now2 = yield* Clock.currentTimeMillis;
                const message = customMessage(o.inputType, text, now2, { details: hosted.route });
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
      // Wait for any in-flight `submit` under `inputs` to see `closing = true` before tearing down the brain scope.
      yield* inputs.withPermits(1)(Effect.void);
      const b = brain;
      if (b) {
        yield* Scope.close(b.scope, Exit.void);
        yield* Fiber.await(b.following);
      }
      yield* inProcess.close.pipe(Effect.catch((err) => log(`in-process run: ${err.message}`)));
    });

    const close = Effect.gen(function* () {
      closing = true;
      // Fork in `owner` rather than the caller's fiber so interrupting one caller does not abort shutdown for others.
      closer ??= yield* Effect.forkIn(closeOnce, owner, { uninterruptible: true });
      yield* Fiber.await(closer);
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
        yield* fs.makeDirectory(join(o.home, "evals"), { recursive: true }).pipe(Effect.mapError((err) => err.pipe(messageOf, refused)));
        yield* encodePretty(evalCase).pipe(
          Effect.flatMap((text) => fs.writeFileString(file, text + "\n", { mode: 0o600 })),
          Effect.mapError((err) => err.pipe(messageOf, refused)),
        );
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

function turnAt(lines: readonly BrainMessage[], text: string, time: number, inputType: string): number {
  const head = text.endsWith("…") ? text.slice(0, -1) : text;
  let at = -1;
  lines.forEach((m, i) => {
    const prev = lines[at];
    if (isHosted(m, inputType) && m.timestamp <= time && messageText(m).includes(head) && (!prev || m.timestamp >= prev.timestamp)) at = i;
  });
  return at;
}

/** Excludes `compactionSummary` entries appended after the turn settled. */
function turnOf(rest: readonly BrainMessage[], inputType: string): BrainMessage[] {
  const out: BrainMessage[] = [];
  for (const m of rest) {
    if (isHosted(m, inputType)) break;
    if (m.role !== "compactionSummary") out.push(m);
  }
  return out;
}
