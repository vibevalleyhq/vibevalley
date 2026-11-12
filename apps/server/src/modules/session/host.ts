import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type Brain, type BrainEvent, makeBrain, sessionUnfinished } from "@vibevalley/agent/brain";
import type { Tool } from "@vibevalley/agent/core/loop";
import { type MemoryPort } from "@vibevalley/agent/memory";
import { type BrainMessage, type CustomMessage, customMessage, messageText } from "@vibevalley/agent/messages";
import { readLines, replay } from "@vibevalley/agent/session";
import type { ModelClient } from "@vibevalley/ai/client";
import type { Usage } from "@vibevalley/ai/messages";
import { abortable, Semaphore, type Task, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { BizCode, messageOf, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { type Core } from "#/core/core.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";

import { makeInProcessRun, NotRecorded, RunBusy, type RunInput } from "./inProcessRun.ts";
import type { Journal } from "./journal.ts";
import type { ToolStart } from "./reaction.ts";
import type { RunStore } from "./registry.ts";
import { tokensOf, usageText } from "./report.ts";
import type { SessionIdentity } from "./signals.ts";

const refused = refuseIn(BizCode.SessionRefused);

/** The caller's turn ended without its answer; cause is what failed it. */
export class NotAnswered extends Error {
  override readonly name = "NotAnswered";
}

/** The one reader's side: what it has not taken yet, and how it ends. */
interface Reader {
  readonly items: string[];
  ended: boolean;
  failure: NotAnswered | undefined;
  wake: (() => void) | undefined;
}

type CallerState =
  | { readonly _tag: "buffering"; readonly kept: string[] }
  | { readonly _tag: "streaming"; readonly reader: Reader }
  | { readonly _tag: "ended"; readonly kept: readonly string[] }
  | { readonly _tag: "failed"; readonly kept: readonly string[]; readonly failure: NotAnswered };

const readerOf = (items: readonly string[], ended: boolean, failure?: NotAnswered): Reader => ({ items: [...items], ended, failure, wake: undefined });

const wake = (reader: Reader) => {
  const w = reader.wake;
  reader.wake = undefined;
  w?.();
};

/** Streams one turn's text to an in-process caller; superseded when a newer input joins the run. */
export class Caller {
  private state: CallerState = { _tag: "buffering", kept: [] };

  push(text: string) {
    switch (this.state._tag) {
      case "buffering":
        this.state.kept.push(text);
        return;
      case "streaming":
        this.state.reader.items.push(text);
        wake(this.state.reader);
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
        this.state.reader.ended = true;
        wake(this.state.reader);
        this.state = { _tag: "ended", kept: [] };
        return;
      case "ended":
      case "failed":
        return;
    }
  }

  fail(cause: unknown) {
    const failure = new NotAnswered(messageOf(cause), { cause });
    switch (this.state._tag) {
      case "buffering":
        this.state = { _tag: "failed", kept: this.state.kept, failure };
        return;
      case "streaming":
        this.state.reader.failure = failure;
        wake(this.state.reader);
        this.state = { _tag: "failed", kept: [], failure };
        return;
      case "ended":
      case "failed":
        return;
    }
  }

  /** The words, as they come, from the first read: what came before is kept for it. A later reader takes the stream over
   * (and gets only what the one before had not). Throws NotAnswered after the words before the failure. */
  words(signal?: AbortSignal): AsyncIterable<string> {
    return { [Symbol.asyncIterator]: () => this.#read(signal) };
  }

  async *#read(signal?: AbortSignal): AsyncGenerator<string> {
    const reader = this.#attach();
    for (;;) {
      const next = reader.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (reader.failure) throw reader.failure;
      if (reader.ended) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      reader.wake = resolve;
      await abortable(promise, signal);
    }
  }

  #attach(): Reader {
    switch (this.state._tag) {
      case "buffering": {
        const reader = readerOf(this.state.kept, false);
        this.state = { _tag: "streaming", reader };
        return reader;
      }
      case "ended": {
        const reader = readerOf(this.state.kept, true);
        this.state = { _tag: "ended", kept: [] };
        return reader;
      }
      case "failed": {
        const reader = readerOf(this.state.kept, false, this.state.failure);
        this.state = { _tag: "failed", kept: [], failure: this.state.failure };
        return reader;
      }
      case "streaming": {
        // The new reader takes over: the one before waits on, as a queue nobody offers to any more.
        const reader = readerOf([], false);
        this.state = { _tag: "streaming", reader };
        return reader;
      }
    }
  }
}

class CannotStart extends Error {
  override readonly name = "CannotStart";
}

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
  readonly say: (route: R, text: string, run: string) => Promise<void>;
  readonly channel: (route: R) => string | undefined;
  /** Invoked when the brain starts or compacts so stale prompt state can be reset. */
  readonly fresh: () => void;
  readonly restored: (route: R) => RunInput;
  /** 0 retains all events. */
  readonly keepEvents?: number;
  readonly toolStart: (tool: string, args: unknown) => ToolStart;
}

export type Build = (busy: boolean, memoryNews: string) => Promise<{ readonly text: string; readonly heard?: readonly string[] }>;

export class SubmitRefused extends Error {
  override readonly name = "SubmitRefused";
  readonly why: string;
  readonly run: string;
  constructor(why: string, run: string) {
    super(why);
    this.why = why;
    this.run = run;
  }
}

export interface AgentHost<R> extends AsyncDisposable {
  readonly current: () => Hosted<R>;
  readonly unfinished: () => Promise<boolean>;
  /** `now: true` steers into the active run; `false` queues until the active run settles. Throws what build threw, or
   * SubmitRefused. */
  readonly submit: (build: Build, input: Hosted<R>, now: boolean) => Promise<void>;
  readonly resume: (maxAgeMs: number) => Promise<void>;
  readonly stop: () => Promise<void>;
  /** The signal stops only this caller's waiting: the close, once begun, runs to its end for every caller. */
  readonly close: (signal?: AbortSignal) => Promise<void>;
  readonly markWrong: (on: number, want: string, model: string, tools: readonly string[]) => Promise<{ id: string; file: string }>;
}

export interface HostDeps {
  readonly core: Core;
  readonly clock: Time;
  readonly log: Logger;
}

export async function makeHost<R>(
  o: HostOptions<R> & { readonly memory: MemoryPort },
  journal: Journal,
  runs: RunStore,
  deps: HostDeps,
): Promise<AgentHost<R>> {
  const { core, clock } = deps;
  const logger = deps.log.child(o.session.id);
  const inProcess = makeInProcessRun(o.session.id, journal, o.toolStart, runs);
  const transcript = join(o.home, o.session.id + ".jsonl");
  const local = new WeakMap<BrainMessage, Hosted<R>>();
  // The brain's events are followed here, so the brain waits for none of what they start.
  const tasks = new TaskGroup({ name: `host ${o.session.id}`, onError: (task, e) => logger.error(`vibevalley: ${task}`, e) });
  let input: Hosted<R> = { route: o.first, run: { by: { kind: "" } } };
  let toCaller = 0;
  let open = false;
  let prefixChanged: string[] = [];
  let closing = false;
  let closer: Promise<void> | undefined;
  let brain: { readonly brain: Brain; readonly following: Task<unknown> } | undefined;
  // Serializes input construction and brain delivery so transcript entries preserve arrival order.
  const inputs = new Semaphore(1);
  const stopped = () => t("server.session.host.stopped", { label: o.session.name });
  const log = (text: string) => logger.error(`vibevalley: ${text}`);

  const current = (): Hosted<R> => {
    const messages = brain?.brain.history() ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a custom message of this host's input type carries the route this host put in it
      if (m && isHosted(m, o.inputType)) return local.get(m) ?? { route: m.details as R, run: { by: { kind: "" } } };
    }
    return input;
  };

  const closeInput = (hosted: Hosted<R>): never => {
    hosted.caller?.end();
    throw new SubmitRefused(stopped(), "");
  };

  const activity = (action: T.SessionAction, route?: R) => {
    const id = sessionId(o.session.id);
    const session = core.session(id);
    if (!session) return;
    const phase = session.phase;
    const channel = route === undefined ? undefined : o.channel(route);
    core.apply({
      type: "sessionPhaseChanged",
      id,
      phase: { _tag: "working", since: phase._tag === "working" ? phase.since : clock.now(), doing: { action, label: "" } },
      ...(channel === undefined ? {} : { channel }),
    });
  };

  const grow = (text: string) => {
    const at = input;
    if (at.caller && text.length > toCaller) {
      at.caller.push(text.slice(toCaller));
      toCaller = text.length;
    }
    if (open) return;
    open = true;
    activity("speaking_text", at.route);
  };

  const done = async (text: string) => {
    const at = input;
    if (at.caller && text.length > toCaller) at.caller.push(text.slice(toCaller));
    if (at.caller && text) at.caller.push("\n");
    toCaller = 0;
    const wrote = open;
    open = false;
    if (text && !o.quiet(at.route)) await o.say(at.route, text, inProcess.currentRun());
    if (wrote) activity("thinking", at.route);
  };

  const settled = (aborted: boolean) => {
    if (aborted && !closing) journal.note("run/error", t("server.session.log.stoppedByUser"));
    input.caller?.end();
    input = { route: input.route, run: input.run };
    open = false;
  };

  const noteUsage = (u: Usage | undefined) => {
    if (!u || (u.input === 0 && u.cacheRead === 0 && u.output === 0)) return;
    const changed = prefixChanged;
    prefixChanged = [];
    const tokens = tokensOf(u);
    journal.usage(tokens, usageText(tokens, changed));
  };

  const event = async (e: BrainEvent): Promise<void> => {
    let run: RunInput | undefined;
    if (e.type === "message_start" && isHosted(e.message, o.inputType)) run = local.get(e.message)?.run ?? { by: { kind: "" } };
    if (
      e.type !== "agent_settled" &&
      e.type !== "compaction_start" &&
      e.type !== "compaction_end" &&
      e.type !== "prefix_changed" &&
      e.type !== "todos_changed" &&
      e.type !== "agent_closed"
    ) {
      try {
        await inProcess.observe(e, run);
      } catch (err) {
        if (!(err instanceof NotRecorded)) throw err;
        core.notice("error", t("server.session.host.notRecorded", { label: o.session.name, why: err.message }));
      }
    }
    switch (e.type) {
      case "message_start":
        if (isHosted(e.message, o.inputType)) {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a custom message of this host's input type carries the route this host put in it
          const next = local.get(e.message) ?? { route: e.message.details as R, run: { by: { kind: "" } } };
          if (input.caller && input.caller !== next.caller) input.caller.end();
          input = next;
          toCaller = 0;
          activity("thinking", next.route);
        }
        return;
      case "agent_start":
        return activity("thinking");
      case "message_update": {
        if (e.message.role !== "assistant") return;
        const text = messageText(e.message);
        if (text) grow(text);
        return;
      }
      case "message_end": {
        if (e.message.role !== "assistant") return;
        const m = e.message;
        noteUsage(m.usage);
        await done(messageText(m).trim());
        if (m.stopReason === "error")
          core.notice("error", t("server.session.host.failed", { label: o.session.name, why: m.errorMessage || t("server.agent.modelFailed") }));
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
        logger.info(`vibevalley: the prompt start changed between compactions: ${e.parts.join(",")}`);
        prefixChanged = e.parts;
        return;
      case "agent_settled":
        return settled(e.run.aborted);
      default:
        return;
    }
  };

  // Lazily initialized under `inputs` semaphore so startup succeeds even before model keys are configured.
  const start = async (): Promise<Brain> => {
    if (brain) return brain.brain;
    if (closing) throw new CannotStart(stopped());
    let llm: ModelClient;
    try {
      llm = o.llm();
    } catch (e) {
      throw new CannotStart(messageOf(e), { cause: e });
    }
    const made = await makeBrain({
      name: o.session.id,
      instructions: o.instructions,
      memory: o.memory,
      llm,
      home: o.home,
      cwd: o.cwd,
      clock,
      log: logger,
      tools: o.tools(() => current().route),
      ...(o.skills === undefined ? { noSkills: true } : { skills: o.skills }),
      noSubagents: true,
      reminders: false,
      ...(o.wakeSoon ? { wakeSoon: o.wakeSoon } : {}),
    });
    o.fresh();
    // Subscribed before anything is sent; followed one at a time in order until the brain's events end (after it closed).
    const events = made.events();
    const following = tasks.run("following its agent", async () => {
      for await (const e of events) {
        try {
          await event(e);
        } catch (c) {
          log(`could not follow its agent: ${messageOf(c)}`);
        }
      }
    });
    logger.info(`vibevalley: on vibevalley's own agent, model ${llm.model.id}`);
    brain = { brain: made, following };
    return made;
  };

  const submit = async (build: Build, hosted: Hosted<R>, now: boolean): Promise<void> => {
    if (closing) return closeInput(hosted);
    const run: RunInput = { ...hosted.run, by: hosted.run.by.kind ? hosted.run.by : { kind: "comment" } };
    return inputs.with(async () => {
      let b: Brain;
      try {
        b = await start();
      } catch (err) {
        if (closing) return closeInput(hosted);
        const why = messageOf(err);
        let id = "";
        try {
          id = await inProcess.failedStart(run, hosted.run.asked ?? "", t("server.session.host.cannotStart", { why }));
        } catch (e) {
          if (!(e instanceof NotRecorded || e instanceof RunBusy)) throw e;
          core.notice("error", t("server.session.host.notRecorded", { label: o.session.name, why: e.message }));
        }
        core.notice("error", t("server.session.host.startFailed", { label: o.session.name, why }));
        hosted.caller?.push(t("server.session.host.callerStart", { why }));
        hosted.caller?.end();
        throw new SubmitRefused(why, id);
      }
      if (closing) return closeInput(hosted);
      const busy = b.busy() || (await b.queued());
      const memoryNews = await b.memoryNews();
      const { text, heard } = await build(busy, memoryNews);
      if (closing) return closeInput(hosted);
      const message = customMessage(o.inputType, text, clock.now(), { details: hosted.route });
      local.set(message, { ...hosted, run: { ...run, ...(heard ? { heard } : {}) } });
      await (now ? b.send(message) : b.later(message));
    });
  };

  const resume = (maxAgeMs: number) =>
    inputs.with(async () => {
      if (closing) return;
      let b: Brain | undefined;
      try {
        b = await start();
      } catch (e) {
        if (!closing) log(`could not go on with its last run: ${messageOf(e)}`);
      }
      if (!b || closing) return;
      const at = current();
      input = at;
      toCaller = 0;
      inProcess.resume(o.restored(at.route));
      if (await b.resume(maxAgeMs)) return;
      inProcess.resume(undefined);
      if (!b.busy()) journal.note("run/error", t("server.session.log.staleRun"));
    });

  const closeOnce = async () => {
    // Wait for any in-flight `submit` under `inputs` to see `closing = true` before tearing down the brain.
    await inputs.with(async () => {});
    const b = brain;
    if (b) {
      await b.brain.close();
      await b.following.done;
    }
    try {
      await inProcess.close();
    } catch (err) {
      if (!(err instanceof NotRecorded)) throw err;
      log(`in-process run: ${err.message}`);
    }
    await tasks.close();
  };

  const close = (signal?: AbortSignal) => {
    closing = true;
    // One close for every caller, started without any caller's signal: a caller that stops waiting does not stop it.
    closer ??= closeOnce();
    return abortable(closer, signal);
  };

  const markWrong = async (on: number, want: string, model: string, tools: readonly string[]) => {
    const w = want.trim();
    if (!w) throw refused(t("server.session.host.markNeedsWords"));
    const asked = journal.events().find((e) => e.seq === on);
    if (!asked) throw missing(t("server.session.host.noStep", { label: o.session.name, on }), [{ say: t("server.session.host.stepHint") }]);
    if (asked.type !== "user/message") throw refused(t("server.session.host.notAsked", { on, label: o.session.name }));
    const lines = await readLines(transcript, undefined, logger);
    const at = turnAt(lines, asked.text, asked.time, o.inputType);
    if (at < 0) throw refused(t("server.session.host.notInConversation", { on, label: o.session.name }));
    let memoryText: string;
    try {
      memoryText = (await o.memory.read()).prompt;
    } catch (e) {
      throw refused(messageOf(e));
    }
    const id = newId();
    const evalCase = {
      id,
      createdAt: clock.now(),
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
    try {
      await mkdir(join(o.home, "evals"), { recursive: true });
      await writeFile(file, JSON.stringify(evalCase, null, 2) + "\n", { mode: 0o600 });
    } catch (e) {
      throw refused(messageOf(e));
    }
    return { id, file };
  };

  return {
    current,
    unfinished: () => sessionUnfinished(transcript),
    submit,
    resume,
    stop: async () => {
      await brain?.brain.stop();
    },
    close,
    [Symbol.asyncDispose]: () => close(),
    markWrong,
  };
}

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
