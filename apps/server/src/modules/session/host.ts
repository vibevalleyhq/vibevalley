import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import {
  type Conversation,
  type ConversationView,
  type ConversationWatch,
  type Cursor,
  defineExtension,
  type EntryId,
  type EntryRecord,
  section,
} from "@earendil-works/pi-durable";
import { z } from "zod";

import type { Tool } from "@vibevalley/agent/core/tool";
import { type MemoryPort } from "@vibevalley/agent/memory";
import { selfTools } from "@vibevalley/agent/self";
import { scanSkills, skillIndex } from "@vibevalley/agent/skills";
import { abortable, Semaphore, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { BizCode, messageOf, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { type Core } from "#/core/core.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import { type DeepSeekModel, type Durable, durableTool, entryMessage, messageText, type ModelMessage } from "#/modules/agent/durable.ts";

import { makeInProcessRun, NotRecorded, RunBusy, type RunEvent, type RunInput } from "./inProcessRun.ts";
import type { Journal } from "./journal.ts";
import { hostWords } from "./prompts.ts";
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
  /** The DeepSeek model it asks, as its profile names it ("" is the default); read as it starts, and may throw why it
   * cannot be asked. */
  readonly model: () => string;
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
  readonly durable: Durable;
}

const context = BACKGROUND_CONTEXT;

/** The run as the conversation's entries tell it: said its last answer (an input placed now starts the next run), its
 * last message, and whether its words are being spoken. */
interface Running {
  readonly _tag: "running";
  answered: boolean;
  last: AssistantMessage | undefined;
  speaking: boolean;
}
type Followed = { readonly _tag: "idle" } | Running;

interface Watching {
  readonly conversation: Conversation;
  readonly watch: ConversationWatch;
}
/** The conversation and its watch, once started; followed from the first listen. */
type Attached = { readonly _tag: "none" } | (Watching & { readonly _tag: "watching" | "following" });

/** What a hosted input's entry carries: the route it came by, and the key of what this process kept of it. */
const InputData = z.object({ key: z.string(), route: z.json() });

/** As much of pi.live as the host follows: whether a run is under way, the answer growing, why the last run failed. */
const LiveView = z.object({
  run: z.exactOptional(z.object({ first: z.exactOptional(z.number()) })),
  generation: z.exactOptional(
    z.object({ message: z.exactOptional(z.object({ content: z.array(z.object({ type: z.string(), text: z.exactOptional(z.string()) })) })) }),
  ),
  runFailure: z.exactOptional(z.object({ reason: z.string(), detail: z.exactOptional(z.string()) })),
});
type LiveView = z.infer<typeof LiveView>;

const answerIn = (e: EntryRecord): AssistantMessage | undefined => {
  const m = entryMessage(e);
  return m?.role === "assistant" ? m : undefined;
};

const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** The message a run that ended without one says it with: why it failed, or that it was stopped. */
const endedWith = (stopReason: "error" | "aborted", why: string, at: number): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "",
  provider: "",
  model: "",
  usage: zeroUsage(),
  stopReason,
  ...(why ? { errorMessage: why } : {}),
  timestamp: at,
});

export async function makeHost<R>(
  o: HostOptions<R> & { readonly memory: MemoryPort },
  journal: Journal,
  runs: RunStore,
  deps: HostDeps,
): Promise<AgentHost<R>> {
  const { core, clock, durable } = deps;
  const logger = deps.log.child(o.session.id);
  const inProcess = makeInProcessRun(o.session.id, journal, o.toolStart, runs);
  /** What this process kept of each input it submitted, by its entry's key: the caller and the run it starts. */
  const local = new Map<string, Hosted<R>>();
  const tasks = new TaskGroup({ name: `host ${o.session.id}`, onError: (task, e) => logger.error(`vibevalley: ${task}`, e) });
  let input: Hosted<R> = { route: o.first, run: { by: { kind: "" } } };
  let toCaller = 0;
  let closing = false;
  let closer: Promise<void> | undefined;
  let attached: Attached = { _tag: "none" };
  // Serializes input construction and submission so the transcript keeps their arrival order.
  const inputs = new Semaphore(1);
  const stopped = () => t("server.session.host.stopped", { label: o.session.name });
  const log = (text: string) => logger.error(`vibevalley: ${text}`);

  // What the model was told of its memory: the prompt keeps it until the conversation folds; news in an input tells
  // what changed since.
  let knownMemory: readonly string[] = [];
  let memoryShown = false;
  const memoryLines = async () => [...(await o.memory.read()).lines];

  const skills = () => scanSkills(o.skills ?? []);
  const tools = [...o.tools(() => current().route), ...selfTools({ now: () => clock.now(), home: o.home, skills, memory: o.memory, log: logger })];
  // The assistant's prompt, part by part as its own loop wrote it; a part that changes is sent again as itself.
  const routeOf = (data: z.infer<typeof InputData>): R =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an entry of this host's input kind carries the route this host put in it
    data.route as R;

  const extension = defineExtension({
    name: `vibevalley.${o.session.id}`,
    tools: tools.map(durableTool),
    sections: [
      section("assistant", () => o.instructions.trim() || undefined, { tag: false }),
      section("env", () => hostWords.envSection(o.cwd), { tag: false }),
      section(
        "skills",
        async () => {
          const found = await skills();
          return found.length > 0 ? hostWords.skillsSection(skillIndex(found)) : undefined;
        },
        { tag: false },
      ),
      section(
        "memory",
        async (at) => {
          if (memoryShown) return at.shown.memory;
          const read = await o.memory.read();
          knownMemory = [...read.lines];
          memoryShown = true;
          return read.prompt ? hostWords.memorySection(read.prompt) : undefined;
        },
        { tag: false },
      ),
    ],
  });
  durable.registry.install(extension);
  // The route of the newest input as the conversation kept it: a run the harness goes on with before this host starts
  // calls its tools with it.
  const keptRoute = await newestRoute(durable, o.session.id, o.inputType);
  if (keptRoute !== undefined) input = { route: routeOf(keptRoute), run: { by: { kind: "" } } };

  const current = (): Hosted<R> => input;

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

  // The run as the conversation's entries tell it.
  let run: Followed = { _tag: "idle" };
  const going = (): Running => (run._tag === "running" ? run : (run = { _tag: "running", answered: false, last: undefined, speaking: false }));

  const grow = (text: string) => {
    const at = input;
    if (at.caller && text.length > toCaller) {
      at.caller.push(text.slice(toCaller));
      toCaller = text.length;
    }
    const r = going();
    if (r.speaking) return;
    r.speaking = true;
    activity("speaking_text", at.route);
  };

  const done = async (text: string) => {
    const at = input;
    if (at.caller && text.length > toCaller) at.caller.push(text.slice(toCaller));
    if (at.caller && text) at.caller.push("\n");
    toCaller = 0;
    const r = going();
    const wrote = r.speaking;
    r.speaking = false;
    if (text && !o.quiet(at.route)) await o.say(at.route, text, inProcess.currentRun());
    if (wrote) activity("thinking", at.route);
  };

  const settled = (aborted: boolean) => {
    if (aborted && !closing) journal.note("run/error", t("server.session.log.stoppedByUser"));
    input.caller?.end();
    input = { route: input.route, run: input.run };
  };

  const noteUsage = (u: Usage) => {
    if (u.input === 0 && u.cacheRead === 0 && u.output === 0) return;
    const tokens = tokensOf(u);
    journal.usage(tokens, usageText(tokens, []));
  };

  const observe = async (e: RunEvent, run?: RunInput) => {
    try {
      await inProcess.observe(e, run);
    } catch (err) {
      if (!(err instanceof NotRecorded)) throw err;
      core.notice("error", t("server.session.host.notRecorded", { label: o.session.name, why: err.message }));
    }
  };

  // The newest entry of the conversation taken.
  let seen: EntryId | undefined;
  const toolsStarted = new Set<string>();

  const placed = async (e: EntryRecord, live: LiveView | undefined) => {
    const data = InputData.parse(e.data);
    if (run._tag === "running" && (run.answered || e.id === live?.run?.first)) await ended(undefined);
    const user = entryMessage(e);
    const at = user?.timestamp ?? clock.now();
    const next = local.get(data.key) ?? { route: routeOf(data), run: { by: { kind: "" } } };
    local.delete(data.key);
    going().answered = false;
    await observe({ type: "message_start", message: { role: "user", content: user ? messageText(user) : "", timestamp: at } }, next.run);
    if (input.caller && input.caller !== next.caller) input.caller.end();
    input = next;
    toCaller = 0;
    activity("thinking", next.route);
  };

  const answer = async (m: AssistantMessage) => {
    const r = going();
    const calls = m.content.filter((c) => c.type === "toolCall");
    r.last = m;
    r.answered = m.stopReason !== "toolUse" || calls.length === 0;
    await observe({ type: "message_end", message: m });
    noteUsage(m.usage);
    const text = messageText(m).trim();
    // An answer whole before any of it was shown is spoken all the same.
    if (text) grow(text);
    await done(text);
    if (m.stopReason === "error")
      core.notice("error", t("server.session.host.failed", { label: o.session.name, why: m.errorMessage || t("server.agent.modelFailed") }));
    for (const call of calls) {
      toolsStarted.add(call.id);
      await observe({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
    }
  };

  const result = async (e: EntryRecord) => {
    const r = entryMessage(e);
    if (r?.role !== "toolResult") return;
    if (!toolsStarted.delete(r.toolCallId)) await observe({ type: "tool_execution_start", toolCallId: r.toolCallId, toolName: r.toolName, args: {} });
    await observe({ type: "tool_execution_end", toolCallId: r.toolCallId, toolName: r.toolName, result: { content: r.content }, isError: r.isError });
  };

  /** The run ends: as its last answer says, or, when none says it, as the failure pi-durable kept. */
  const ended = async (failure: LiveView["runFailure"]) => {
    const now = clock.now();
    const last = going().last;
    const stoppedRun = failure?.reason === "aborted" || last?.stopReason === "aborted";
    if (failure && !stoppedRun && last?.stopReason !== "error") {
      const why = failure.detail ?? failure.reason;
      await answer(endedWith("error", why, now));
    }
    await observe({ type: "agent_end", messages: [stoppedRun ? endedWith("aborted", "", now) : (last ?? endedWith("error", "", now))] });
    settled(stoppedRun);
    run = { _tag: "idle" };
    toolsStarted.clear();
  };

  /** The entries after the newest taken, oldest first: those the window holds, and those it dropped before them. */
  const fresh = async (conversation: Conversation, view: ConversationView): Promise<EntryRecord[]> => {
    const after = (e: EntryRecord) => seen === undefined || e.id > seen;
    const missed =
      view.before !== undefined && seen !== undefined && view.before > seen
        ? (await conversation.entries({ order: "ascending", minEntryId: seen, maxEntryId: view.before }, 10_000, undefined, context)).items
        : [];
    return [...missed, ...view.entries].filter(after);
  };

  const follow = async (conversation: Conversation, view: ConversationView) => {
    const raw = view.docs["pi.live"];
    const live = raw === undefined ? undefined : LiveView.parse(raw);
    const entries = await fresh(conversation, view);
    for (const [i, e] of entries.entries()) {
      seen = e.id;
      if (e.kind === o.inputType) await placed(e, live);
      else if (e.kind === "pi.assistant") {
        const m = answerIn(e);
        if (!m) continue;
        // A partial a restart cut off: the run asks the model again, and the answer that comes is the one said.
        const askedAgain = m.stopReason === "aborted" && (live?.run !== undefined || entries.slice(i + 1).some((later) => later.kind === "pi.assistant"));
        if (!askedAgain) await answer(m);
      } else if (e.kind === "pi.tool-result") await result(e);
      else if (e.kind === "pi.compaction") {
        memoryShown = false;
        o.fresh();
      }
    }
    if (live?.run === undefined) {
      if (run._tag === "running") await ended(live?.runFailure);
      return;
    }
    if (run._tag === "idle") {
      going();
      activity("thinking");
    }
    const partial = live.generation?.message?.content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("");
    if (partial) grow(partial);
  };

  /** The conversation, its watch attached: nothing is followed until listen. */
  const start = async () => {
    if (attached._tag !== "none") return attached;
    if (closing) throw new CannotStart(stopped());
    let model: DeepSeekModel;
    try {
      // The model the profile names is refused before a missing key, as it always was.
      model = durable.model(o.model());
      const cannot = durable.cannotAsk();
      if (cannot !== undefined) throw new Error(cannot);
    } catch (e) {
      throw new CannotStart(messageOf(e), { cause: e });
    }
    const conversation = await durable.conversation(o.session.id, { model: model.ref, extensions: [extension], thinkingLevel: "off" });
    const watch = await conversation.watch(context);
    const entries = watch.value.entries;
    seen = entries.at(-1)?.id;
    const lastInput = entries.findLast((e) => e.kind === o.inputType);
    const data = lastInput === undefined ? undefined : InputData.safeParse(lastInput.data);
    if (data?.success === true) input = { route: routeOf(data.data), run: { by: { kind: "" } } };
    knownMemory = await memoryLines();
    memoryShown = false;
    if (await durable.busy(o.session.id)) {
      // The run recorded before the restart is the one that goes on; an input queued with no run recorded yet starts
      // one as it was asked.
      const unended = await runs.unended(o.session.id);
      if (unended) {
        inProcess.adopt(unended.id);
        going();
      } else inProcess.resume(o.restored(input.route));
    }
    o.fresh();
    logger.info(`vibevalley: on vibevalley's own agent (pi-durable), model ${model.ref.modelId}`);
    attached = { _tag: "watching", conversation, watch };
    return attached;
  };

  /** Takes the conversation in from the newest entry start saw, one commit (or several, folded) at a time. */
  const listen = (s: Watching) => {
    if (attached._tag !== "watching") return;
    attached = { ...s, _tag: "following" };
    s.watch.start(async (call) => {
      if (call.kind !== "value") return;
      try {
        await follow(s.conversation, call.value);
      } catch (e) {
        log(`could not follow its conversation: ${messageOf(e)}`);
      }
    });
  };

  const memoryNews = async () => {
    const now = await memoryLines();
    const before = knownMemory;
    knownMemory = now;
    const lines = [...now.filter((l) => !before.includes(l)).map((l) => "+ " + l), ...before.filter((l) => !now.includes(l)).map((l) => "− " + l)];
    return lines.length === 0 ? "" : hostWords.memoryNews(lines.join("\n"));
  };

  const submit = async (build: Build, hosted: Hosted<R>, now: boolean): Promise<void> => {
    if (closing) return closeInput(hosted);
    const run: RunInput = { ...hosted.run, by: hosted.run.by.kind ? hosted.run.by : { kind: "comment" } };
    return inputs.with(async () => {
      let s: Watching;
      try {
        s = await start();
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
      listen(s);
      if (closing) return closeInput(hosted);
      const busy = await durable.busy(o.session.id);
      const { text, heard } = await build(busy, await memoryNews());
      if (closing) return closeInput(hosted);
      const key = newId();
      local.set(key, { ...hosted, run: { ...run, ...(heard ? { heard } : {}) } });
      await s.conversation.submit(
        {
          type: "input",
          content: text,
          whenBusy: now ? "steer" : "followUp",
          entry: { kind: o.inputType, data: { key, route: z.json().parse(hosted.route) } },
        },
        context,
      );
    });
  };

  const resume = (maxAgeMs: number) =>
    inputs.with(async () => {
      // Without a key the run waits, as it was, for the next input to say why it cannot start.
      if (closing || durable.cannotAsk() !== undefined) return;
      let s: Watching | undefined;
      try {
        s = await start();
      } catch (e) {
        if (!closing) log(`could not go on with its last run: ${messageOf(e)}`);
      }
      if (!s || closing) return;
      listen(s);
      if (!(await durable.busy(o.session.id))) return;
      const unended = await runs.unended(o.session.id);
      if (unended && clock.now() - unended.startedAt > maxAgeMs) {
        await s.conversation.abort(context);
        journal.note("run/error", t("server.session.log.staleRun"));
        return;
      }
      durable.harness.resume();
    });

  const closeOnce = async () => {
    // Wait for any in-flight `submit` under `inputs` to see `closing = true` before letting go of the conversation.
    await inputs.with(async () => {});
    if (attached._tag !== "none") await attached.watch.stop();
    // A run under way goes on when the farm opens again: its record stays open for the next host to adopt.
    if (run._tag === "running" && (await durable.busy(o.session.id))) inProcess.leave();
    else
      try {
        await inProcess.close();
      } catch (err) {
        if (!(err instanceof NotRecorded)) throw err;
        log(`in-process run: ${err.message}`);
      }
    input.caller?.end();
    await tasks.close();
  };

  const close = (signal?: AbortSignal) => {
    closing = true;
    // One close for every caller, started without any caller's signal: a caller that stops waiting does not stop it.
    closer ??= closeOnce();
    return abortable(closer, signal);
  };

  const markWrong = async (on: number, want: string, modelName: string, toolNames: readonly string[]) => {
    const w = want.trim();
    if (!w) throw refused(t("server.session.host.markNeedsWords"));
    const asked = journal.events().find((e) => e.seq === on);
    if (!asked) throw missing(t("server.session.host.noStep", { label: o.session.name, on }), [{ say: t("server.session.host.stepHint") }]);
    if (asked.type !== "user/message") throw refused(t("server.session.host.notAsked", { on, label: o.session.name }));
    const found = await durable.existing(o.session.id);
    const entries = found ? (await found.entries({ order: "ascending" }, 100_000, undefined, context)).items : [];
    const at = turnAt(entries, asked.text, asked.time, o.inputType);
    const turn = at === undefined ? undefined : entries[at];
    if (!found || at === undefined || turn === undefined) throw refused(t("server.session.host.notInConversation", { on, label: o.session.name }));
    let memoryText: string;
    try {
      memoryText = (await o.memory.read()).prompt;
    } catch (e) {
      throw refused(messageOf(e));
    }
    const before = entries[at - 1];
    const id = newId();
    const evalCase = {
      id,
      createdAt: clock.now(),
      model: modelName,
      want: w,
      memory: memoryText,
      tools: toolNames,
      before: before === undefined ? [] : modelMessages((await found.context(context, { at: before.id })).messages),
      input: inputMessage(turn, o.inputType),
      did: turnOf(entries.slice(at + 1), o.inputType),
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
    unfinished: () => durable.busy(o.session.id),
    submit,
    resume,
    stop: async () => {
      if (attached._tag !== "none") await attached.conversation.abort(context);
    },
    close,
    [Symbol.asyncDispose]: () => close(),
    markWrong,
  };
}

/** What the newest input of inputType in key's conversation carries, if it has one. */
async function newestRoute(durable: Durable, key: string, inputType: string): Promise<z.infer<typeof InputData> | undefined> {
  const found = await durable.existing(key);
  if (!found) return undefined;
  let cursor: Cursor | undefined;
  do {
    const page = await found.entries({ order: "descending" }, 100, cursor, context);
    const input = page.items.find((e) => e.kind === inputType);
    if (input !== undefined) {
      const data = InputData.safeParse(input.data);
      return data.success ? data.data : undefined;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return undefined;
}

/** A hosted input in an eval case, as it was kept: the input's kind, its words and its route. */
export interface CaseInput {
  readonly role: "custom";
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
  readonly details?: unknown;
  readonly timestamp: number;
}

/** The model's messages, its prompt left out. */
function modelMessages(messages: readonly Message[]): ModelMessage[] {
  return messages.filter((m): m is ModelMessage => m.role !== "system");
}

/** A hosted input's entry as an eval case keeps it: a message of the input kind, with its route. */
function inputMessage(e: EntryRecord, inputType: string): CaseInput {
  const user = entryMessage(e);
  const data = InputData.safeParse(e.data);
  return {
    role: "custom",
    customType: inputType,
    content: user ? messageText(user) : "",
    display: true,
    ...(data.success ? { details: data.data.route } : {}),
    timestamp: user?.timestamp ?? 0,
  };
}

/** The newest input of this host's kind asked by then whose words hold text (cut with … in the log). */
function turnAt(entries: readonly EntryRecord[], text: string, time: number, inputType: string): number | undefined {
  const head = text.endsWith("…") ? text.slice(0, -1) : text;
  let at: number | undefined;
  entries.forEach((e, i) => {
    if (e.kind !== inputType) return;
    const user = entryMessage(e);
    if (user && user.timestamp <= time && messageText(user).includes(head)) at = i;
  });
  return at;
}

/** What the model did after an input, until the next one. */
export function turnOf(rest: readonly EntryRecord[], inputType: string): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const e of rest) {
    if (e.kind === inputType) break;
    if (e.kind !== "pi.assistant" && e.kind !== "pi.tool-result") continue;
    const m = entryMessage(e);
    if (m) out.push(m);
  }
  return out;
}
