import { t } from "@vibevalley/i18n";
// An agent that runs in this process (the orchestrator) on VibeValley's own agent (agent/brain): the agent started on
// first use, its inputs queued in order, its words streamed to where each input came from, its runs recorded
// (execution.ts), the run a restart cut off taken up again, and a turn it got wrong kept as an eval case.
//
// Every input carries a route the host does not read: the one that owns the agent says what it means and where its words
// go. An input given while the agent is busy may be taken after one given later; the words follow the agent's events, so
// they go to the route of the input taken last, and the tools read that route too.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "@vibevalley/ai/messages";
import type { Tool } from "@vibevalley/agent/core/loop";
import type { OrchestratorState } from "@vibevalley/protocol";
import { Effect, type Scope } from "effect";
import { type BrainEvent, type BrainHandle, openBrain, sessionUnfinished } from "@vibevalley/agent/brain";
import type { ModelClient } from "@vibevalley/ai/client";
import { memoryFile } from "@vibevalley/agent/memory";
import { type BrainMessage, type CustomMessage, customMessage, messageText } from "@vibevalley/agent/messages";
import { readLines, replay } from "@vibevalley/agent/session";
import { newId } from "../base/ids.ts";
import { type ApiError, missing, refused } from "../errors.ts";
import { AgentExecution, type RunInput } from "./execution.ts";
import type { ToolStart } from "./facts.ts";
import type { Journal } from "./journal.ts";
import type { RunStore } from "./session.ts";
import { tokensOf, usageText } from "./usage.ts";
import type { Time } from "../base/time.ts";

/** One answer streamed to a caller (a call's line, a chat/completions request). A newer one ends the one before. */
export class Caller {
  private readonly queue: string[] = [];
  private ended = false;
  private failed = false;
  private failure: unknown;
  private wake: (() => void) | undefined;

  push(text: string) {
    if (!this.ended) this.queue.push(text);
    this.wake?.();
  }

  end() {
    this.ended = true;
    this.wake?.();
  }

  fail(error: unknown) {
    if (!this.ended) {
      this.failed = true;
      this.failure = error;
    }
    this.end();
  }

  async *words(signal?: AbortSignal): AsyncGenerator<string> {
    while (!signal?.aborted) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) {
        if (this.failed) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const wake = () => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", wake);
          if (this.wake === wake) this.wake = undefined;
          resolve();
        };
        this.wake = wake;
        signal?.addEventListener("abort", wake, { once: true });
        if (signal?.aborted) wake();
      });
    }
  }
}

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
  readonly say: (route: R, text: string, run: string) => Promise<void>;
  /** route: the input it works for, once it has taken one in this run; its words go there. */
  readonly state: (state: OrchestratorState, route?: R) => Promise<void>;
  /** The agent started, or folded its conversation: what the model saw before is gone from it. */
  readonly fresh: () => void;
  /** The run an input found in the transcript after a restart goes on with: its issue and trigger, from its route. */
  readonly restored: (route: R) => RunInput;
  /** How many events its log keeps; 0 keeps them all. */
  readonly keepEvents?: number;
  readonly toolStart: (tool: string, args: unknown) => ToolStart;
  readonly notice: (level: "info" | "warn" | "error", text: string) => void;
  readonly log: (level: "info" | "error", text: string) => void;
  /** The owner's fibers, which the agent's run on too. */
  readonly go: <A, E>(e: Effect.Effect<A, E>) => Promise<A>;
  /** The owner's scope: the agent's own is a child of it, so the agent ends with the owner at the latest. */
  readonly scope: Scope.Scope;
}

/** What makes an input's text once it is its turn: whether the agent is busy (an input may be taken after a later one),
 * and what memory gained since the model last saw it. heard: the messages the text tells of, recorded on the run. */
export type Build = (busy: boolean, memoryNews: string) => Promise<{ readonly text: string; readonly heard?: readonly string[] }>;

export class AgentHost<R> {
  private readonly execution: AgentExecution;
  private readonly local = new WeakMap<BrainMessage, Hosted<R>>();
  private readonly transcript: string;
  private input: Hosted<R>;
  private toCaller = 0;
  /** An answer is being written: its words have begun and it is not yet said. */
  private open = false;
  private prefixChanged: string[] = [];
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private brain: BrainHandle | undefined;
  private starting: Promise<BrainHandle> | undefined;
  private events = Promise.resolve();
  /** Held from building an input to handing it over, so that each input's text follows the one before. */
  private inputs = Promise.resolve();

  private readonly journal: Journal;

  /** Made by Sessions.host: its log and its runs are kept with the sessions'. */
  constructor(
    private readonly o: HostOptions<R>,
    journal: Journal,
    runs: RunStore,
    /** The service's Clock: an input's time, and an eval case's. */
    private readonly time: Time,
  ) {
    this.journal = journal;
    this.execution = new AgentExecution(o.name, journal, o.toolStart, runs);
    this.transcript = join(o.home, o.name + ".jsonl");
    this.input = { route: o.first, run: { by: { kind: "" } } };
  }

  /** The input taken last: its route is where words go now. */
  current(): Hosted<R> {
    const messages = this.brain?.history() ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (isHosted(m, this.o.inputType)) return this.local.get(m) ?? { route: m.details as R, run: { by: { kind: "" } } };
    }
    return this.input;
  }

  /** The run a restart cut off is in the transcript. */
  unfinished(): boolean {
    return sessionUnfinished(this.transcript);
  }

  private closeInput(input: Hosted<R>) {
    input.caller?.end();
    return { ok: false as const, why: t("server.session.host.stopped", { label: this.o.label }), run: "" };
  }

  /** now joins the run under way; otherwise the input waits until the run would stop. false and why when the agent
   * cannot start: that input is recorded as a failed run of its own. */
  async submit(
    build: Build,
    input: Hosted<R>,
    now: boolean,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly why: string; readonly run: string }> {
    if (this.closing) return this.closeInput(input);
    const run: RunInput = { ...input.run, by: input.run.by.kind ? input.run.by : { kind: "comment" } };
    return this.serially(async () => {
      let b: BrainHandle;
      try {
        b = await this.start();
      } catch (err) {
        if (this.closing) return this.closeInput(input);
        const why = err instanceof Error ? err.message : String(err);
        const id = await this.o.go(this.execution.failedStart(run, input.run.asked ?? "", t("server.session.host.cannotStart", { why }))).catch((e: Error) => {
          this.o.notice("error", t("server.session.host.notRecorded", { label: this.o.label, why: e.message }));
          return "";
        });
        this.o.notice("error", t("server.session.host.startFailed", { label: this.o.label, why }));
        input.caller?.push(t("server.session.host.callerStart", { why }));
        input.caller?.end();
        return { ok: false, why, run: id };
      }
      if (this.closing) return this.closeInput(input);
      const { text, heard } = await build(b.busy() || (await b.queued()), b.memoryNews());
      if (this.closing) return this.closeInput(input);
      const message = customMessage(this.o.inputType, text, this.time.now(), { details: input.route });
      this.local.set(message, { ...input, run: { ...run, ...(heard ? { heard } : {}) } });
      await (now ? b.send(message) : b.later(message));
      return { ok: true };
    });
  }

  /** The run the last start was cut off in goes on, with the input it was taking, within maxAgeMs. */
  async resume(maxAgeMs: number): Promise<void> {
    return this.serially(async () => {
      if (this.closing) return;
      let b: BrainHandle;
      try {
        b = await this.start();
      } catch (err) {
        if (!this.closing) this.o.log("error", `vibevalley: ${this.o.name} could not go on with its last run: ${String(err)}`);
        return;
      }
      if (this.closing) return;
      const at = this.current();
      this.input = at;
      this.toCaller = 0;
      this.execution.resume(this.o.restored(at.route));
      if (await b.resume(maxAgeMs)) return;
      this.execution.resume(undefined);
      if (!b.busy()) this.journal.note("run/error", t("server.session.log.staleRun"));
    });
  }

  /** The inputs waiting are dropped with the run. */
  async stop(): Promise<void> {
    await this.brain?.stop();
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = Promise.resolve().then(() => this.closeOnce());
    }
    return this.closePromise;
  }

  private async closeOnce() {
    const starting = this.starting;
    await this.inputs;
    const b = this.brain ?? (await starting?.catch(() => undefined));
    await b?.close();
    await this.events;
    await this.o.go(this.execution.close()).catch((err: Error) => this.o.log("error", `${this.o.name} execution: ${err.message}`));
  }

  /** The turn that took step on of the log, kept as an eval case with what it should have done. */
  markWrong(on: number, want: string, model: string, tools: readonly string[]): Effect.Effect<{ id: string; file: string }, ApiError> {
    return Effect.suspend(() => {
      const w = want.trim();
      if (!w) return Effect.fail(refused(t("server.session.host.markNeedsWords")));
      const asked = this.journal.events().find((e) => e.seq === on);
      if (!asked) return Effect.fail(missing(t("server.session.host.noStep", { label: this.o.label, on }), [{ say: t("server.session.host.stepHint") }]));
      if (asked.type !== "user/message") return Effect.fail(refused(t("server.session.host.notAsked", { on, label: this.o.label })));
      const lines = readLines(this.transcript);
      const at = turnAt(lines, asked.text, asked.time, this.o.inputType);
      if (at < 0) return Effect.fail(refused(t("server.session.host.notInConversation", { on, label: this.o.label })));
      let memoryText = "";
      try {
        memoryText = readFileSync(memoryFile(this.o.home), "utf8");
      } catch {
        memoryText = "";
      }
      const id = newId();
      const evalCase = {
        id,
        createdAt: this.time.now(),
        model,
        want: w,
        memory: memoryText,
        tools,
        before: replay(lines.slice(0, at)),
        input: lines[at],
        did: turnOf(lines.slice(at + 1), this.o.inputType),
        expect: [],
      };
      const file = join(this.o.home, "evals", id + ".json");
      try {
        mkdirSync(join(this.o.home, "evals"), { recursive: true });
        writeFileSync(file, JSON.stringify(evalCase, null, 2) + "\n", { mode: 0o600 });
      } catch (err) {
        return Effect.fail(refused(err instanceof Error ? err.message : String(err)));
      }
      return Effect.succeed({ id, file });
    });
  }

  // Started on first use: loading it is not free, and a farm without a model works otherwise.
  private start(): Promise<BrainHandle> {
    if (this.brain) return Promise.resolve(this.brain);
    if (this.closing) return Promise.reject(new Error(t("server.session.host.stopped", { label: this.o.label })));
    this.starting ??= (async () => {
      const llm = this.o.llm();
      const b = await openBrain(
        { run: this.o.go, scope: this.o.scope },
        {
          name: this.o.name,
          instructions: this.o.instructions,
          llm,
          home: this.o.home,
          cwd: this.o.cwd,
          tools: this.o.tools(() => this.current().route),
          noSkills: true,
          noSubagents: true,
          reminders: false,
          ...(this.o.wakeSoon ? { wakeSoon: this.o.wakeSoon } : {}),
        },
      );
      if (this.closing) {
        await b.close();
        throw new Error(t("server.session.host.stopped", { label: this.o.label }));
      }
      this.o.fresh();
      // Listening before the first input is sent.
      b.subscribe((e) => this.follow(e));
      this.o.log("info", `vibevalley: ${this.o.name} is on vibevalley's own agent, model ${llm.model.id}`);
      this.brain = b;
      return b;
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private serially<A>(f: () => Promise<A>): Promise<A> {
    const next = this.inputs.then(f);
    this.inputs = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // The caller (a call's line, the local chat/completions) gets the words as they grow; the chat gets the answer once
  // it is whole, and meanwhile only that it is being written.
  private async grow(text: string) {
    const input = this.input;
    if (input.caller && text.length > this.toCaller) {
      input.caller.push(text.slice(this.toCaller));
      this.toCaller = text.length;
    }
    if (this.open) return;
    this.open = true;
    await this.o.state("speaking", input.route);
  }

  private async done(text: string) {
    const input = this.input;
    if (input.caller && text.length > this.toCaller) input.caller.push(text.slice(this.toCaller));
    if (input.caller && text) input.caller.push("\n");
    this.toCaller = 0;
    const wrote = this.open;
    this.open = false;
    if (text && !this.o.quiet(input.route)) await this.o.say(input.route, text, this.execution.currentRun());
    // The run goes on (its tools, another answer) until it settles.
    if (wrote) await this.o.state("thinking", input.route);
  }

  // Only stop aborts a run while the farm is up; the settle close publishes is the farm stopping.
  private async settled(aborted: boolean) {
    if (aborted && !this.closing) this.journal.note("run/error", t("server.session.log.stoppedByOwner"));
    this.input.caller?.end();
    this.input = { route: this.input.route, run: this.input.run };
    this.open = false;
    await this.o.state("listening");
  }

  // An answer that failed before any token came has none to tell.
  private noteUsage(u: Usage | undefined) {
    if (!u || (u.input === 0 && u.cacheRead === 0 && u.output === 0)) return;
    const changed = this.prefixChanged;
    this.prefixChanged = [];
    const tokens = tokensOf(u);
    this.journal.usage(tokens, usageText(tokens, changed));
  }

  // The agent's events, handled one at a time in order.
  private follow(e: BrainEvent) {
    this.events = this.events
      .then(() => this.event(e))
      .catch((err) => this.o.log("error", `vibevalley: ${this.o.name} could not follow its agent: ${String(err)}`));
  }

  private async event(e: BrainEvent) {
    let run: RunInput | undefined;
    if (e.type === "message_start" && isHosted(e.message, this.o.inputType)) run = this.local.get(e.message)?.run ?? { by: { kind: "" } };
    if (e.type !== "agent_settled" && e.type !== "compaction_start" && e.type !== "compaction_end" && e.type !== "prefix_changed" && e.type !== "tasks_changed")
      await this.o
        .go(this.execution.observe(e, run))
        .catch((err: Error) => this.o.notice("error", t("server.session.host.notRecorded", { label: this.o.label, why: err.message })));
    switch (e.type) {
      case "message_start":
        if (isHosted(e.message, this.o.inputType)) {
          const next = this.local.get(e.message) ?? { route: e.message.details as R, run: { by: { kind: "" } } };
          // An input that joins the run takes the words from here on: the one before has what it got, and ends now, or a
          // caller waiting on it (a brief, a call's line) would wait for the run's end with no words.
          if (this.input.caller && this.input.caller !== next.caller) this.input.caller.end();
          this.input = next;
          this.toCaller = 0;
          // It works for this input from here on, wherever the run began.
          await this.o.state("thinking", next.route);
        }
        return;
      case "agent_start":
        // The input it starts on is taken next (message_start), and says where.
        return this.o.state("thinking");
      case "message_update": {
        if (e.message.role !== "assistant") return;
        const text = messageText(e.message);
        if (text) await this.grow(text);
        return;
      }
      case "message_end": {
        if (e.message.role !== "assistant") return;
        const m = e.message;
        this.noteUsage(m.usage);
        await this.done(messageText(m).trim());
        if (m.stopReason === "error")
          this.o.notice("error", t("server.session.host.failed", { label: this.o.label, why: m.errorMessage || t("server.agent.modelFailed") }));
        return;
      }
      case "compaction_end":
        if (e.usage) {
          const tokens = tokensOf(e.usage);
          this.journal.usage(tokens, t("server.session.log.folded", { usage: usageText(tokens) }));
        }
        if (e.compaction) this.o.fresh();
        return;
      case "prefix_changed":
        this.o.log("info", `vibevalley: ${this.o.name}'s prompt start changed between compactions: ${e.parts.join(",")}`);
        this.prefixChanged = e.parts;
        return;
      case "agent_settled":
        return this.settled(e.run.aborted);
      default:
        break;
    }
  }
}

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
