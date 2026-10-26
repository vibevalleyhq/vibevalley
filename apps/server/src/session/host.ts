// An agent that runs in this process (the orchestrator) on VibeValley's own agent (agent/brain): the agent started on
// first use, its inputs queued in order, its words streamed to where each input came from, its runs recorded
// (execution.ts), the run a restart cut off taken up again, and a turn it got wrong kept as an eval case.
//
// Every input carries a route the host does not read: the one that owns the agent says what it means and where its words
// go. An input given while the agent is busy may be taken after one given later; the words follow the agent's events, so
// they go to the route of the input taken last, and the tools read that route too.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { OrchestratorState } from "@vibevalley/protocol";
import { Effect } from "effect";
import { Brain, type BrainEvent, sessionUnfinished } from "../agent/brain/agent.ts";
import type { LLM } from "../agent/brain/config.ts";
import { memoryFile } from "../agent/brain/memory.ts";
import { type CustomMessage, customMessage, messageText } from "../agent/brain/messages.ts";
import { readLines, replay } from "../agent/brain/session.ts";
import { newId } from "../base/ids.ts";
import { type ApiError, missing, refused } from "../errors.ts";
import { AgentExecution, type RunInput } from "./execution.ts";
import type { ToolStart } from "./facts.ts";
import type { Journal } from "./journal.ts";
import type { RunStore } from "./session.ts";
import { tokensOf, usageText } from "./usage.ts";
import type { Time } from "../base/time.ts";
import type { CallbackLog } from "../base/log.ts";

const streamEveryMs = 120;

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
  readonly llm: () => LLM;
  /** The tools; each reads the route of the input taken last. */
  readonly tools: (current: () => R) => AgentTool[];
  readonly wakeSoon?: (withinMs: number) => boolean;
  /** The route before any input is taken. */
  readonly first: R;
  /** Words are not said for this route (the caller still gets them). */
  readonly quiet: (route: R) => boolean;
  /** Where words go: growing (final false, at most every streamEveryMs) and said in full. */
  readonly say: (route: R, key: string, text: string, final: boolean, run: string) => Promise<void>;
  readonly state: (state: OrchestratorState) => Promise<void>;
  /** The agent started, or folded its conversation: what the model saw before is gone from it. */
  readonly fresh: () => void;
  /** The run an input found in the transcript after a restart goes on with: its issue and trigger, from its route. */
  readonly restored: (route: R) => RunInput;
  /** How many events its log keeps; 0 keeps them all. */
  readonly keepEvents?: number;
  readonly toolStart: (tool: string, args: unknown) => ToolStart;
  readonly notice: (level: "info" | "warn" | "error", text: string) => void;
  readonly log: (level: "info" | "error", text: string) => void;
  readonly go: <A, E>(e: Effect.Effect<A, E>) => Promise<A>;
}

/** What makes an input's text once it is its turn: whether the agent is busy (an input may be taken after a later one),
 * and what memory gained since the model last saw it. heard: the messages the text tells of, recorded on the run. */
export type Build = (busy: boolean, memoryNews: string) => Promise<{ readonly text: string; readonly heard?: readonly string[] }>;

export class AgentHost<R> {
  private readonly execution: AgentExecution;
  private readonly local = new WeakMap<AgentMessage, Hosted<R>>();
  private readonly transcript: string;
  private input: Hosted<R>;
  private toCaller = 0;
  private said = 0;
  private open = false;
  private lastPush = 0;
  private prefixChanged: string[] = [];
  private closing = false;
  private readonly life = new AbortController();
  private closePromise: Promise<void> | undefined;
  private brain: Brain | undefined;
  private starting: Promise<Brain> | undefined;
  private events = Promise.resolve();
  /** Held from building an input to handing it over, so that each input's text follows the one before. */
  private inputs = Promise.resolve();

  private readonly journal: Journal;

  /** Made by Sessions.host: its log and its runs are kept with the sessions'. */
  constructor(
    private readonly o: HostOptions<R>,
    journal: Journal,
    runs: RunStore,
    /** The service's Clock: the streaming window and an eval case's time. */
    private readonly time: Time,
    private readonly log: CallbackLog,
  ) {
    this.journal = journal;
    this.execution = new AgentExecution(o.name, journal, o.toolStart, runs);
    this.transcript = join(o.home, o.name + ".jsonl");
    this.input = { route: o.first, run: { by: { kind: "" } } };
  }

  /** The input taken last: its route is where words go now. */
  current(): Hosted<R> {
    const messages = this.brain?.core.state.messages ?? [];
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
    return { ok: false as const, why: this.o.label + "已经停下", run: "" };
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
      let b: Brain;
      try {
        b = await this.start();
      } catch (err) {
        if (this.closing) return this.closeInput(input);
        const why = err instanceof Error ? err.message : String(err);
        const id = await this.o.go(this.execution.failedStart(run, input.run.asked ?? "", "起不来：" + why)).catch((e: Error) => {
          this.o.notice("error", this.o.label + "的执行没能记下：" + e.message);
          return "";
        });
        this.o.notice("error", this.o.label + "起不来：" + why);
        input.caller?.push("我这边起不来：" + why);
        input.caller?.end();
        return { ok: false, why, run: id };
      }
      if (this.closing) return this.closeInput(input);
      const { text, heard } = await build(b.busy() || b.core.hasQueuedMessages(), b.memoryNews());
      if (this.closing) return this.closeInput(input);
      const message = customMessage(this.o.inputType, text, this.time.now(), { details: input.route });
      this.local.set(message, { ...input, run: { ...run, ...(heard ? { heard } : {}) } });
      if (now) b.send(message);
      else b.later(message);
      return { ok: true };
    });
  }

  /** The run the last start was cut off in goes on, with the input it was taking, within maxAgeMs. */
  async resume(maxAgeMs: number): Promise<void> {
    return this.serially(async () => {
      if (this.closing) return;
      let b: Brain;
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
      if (b.resume(maxAgeMs)) return;
      this.execution.resume(undefined);
      if (!b.busy()) this.journal.note("run/error", "上一轮停在了半路，太久了，没有接着做");
    });
  }

  /** The inputs waiting are dropped with the run. */
  async stop(): Promise<void> {
    await this.brain?.stop();
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.life.abort();
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
      if (!w) return Effect.fail(refused("写一句它应该怎样"));
      const asked = this.journal.events().find((e) => e.seq === on);
      if (!asked) return Effect.fail(missing(`${this.o.label}轨迹里没有第 ${on} 步`, [{ say: "步数在页面上它的日志里，每一步前面的编号" }]));
      if (asked.type !== "user/message") return Effect.fail(refused(`第 ${on} 步不是${this.o.label}收到的话`));
      const lines = readLines(this.transcript);
      const at = turnAt(lines, asked.text, asked.time, this.o.inputType);
      if (at < 0) return Effect.fail(refused(`第 ${on} 步收到的话没进${this.o.label}的对话（那时${this.o.label}没起来？）`));
      let memoryText = "";
      try {
        memoryText = readFileSync(memoryFile(this.o.home), "utf8");
      } catch {
        memoryText = "";
      }
      const id = newId();
      const evalCase = {
        id,
        created: this.time.now(),
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
  private start(): Promise<Brain> {
    if (this.brain) return Promise.resolve(this.brain);
    if (this.closing) return Promise.reject(new Error(this.o.label + "已经停下"));
    this.starting ??= (async () => {
      const llm = this.o.llm();
      const b = await Brain.start(
        {
          time: this.time,
          log: this.log,
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
        this.life.signal,
      );
      if (this.closing) {
        await b.close();
        throw new Error(this.o.label + "已经停下");
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

  private keyNow() {
    if (!this.open) {
      this.open = true;
      this.said++;
    }
    return `m${this.said}`;
  }

  private async grow(text: string) {
    const input = this.input;
    if (input.caller && text.length > this.toCaller) {
      input.caller.push(text.slice(this.toCaller));
      this.toCaller = text.length;
    }
    const key = this.keyNow();
    if (this.o.quiet(input.route) || this.time.now() - this.lastPush < streamEveryMs) return;
    this.lastPush = this.time.now();
    await this.o.state("speaking");
    await this.o.say(input.route, key, text, false, this.execution.currentRun());
  }

  private async done(text: string) {
    const input = this.input;
    if (input.caller && text.length > this.toCaller) input.caller.push(text.slice(this.toCaller));
    if (input.caller && text) input.caller.push("\n");
    this.toCaller = 0;
    const key = this.keyNow();
    this.open = false;
    if (text && !this.o.quiet(input.route)) await this.o.say(input.route, key, text, true, this.execution.currentRun());
  }

  // Only stop aborts a run while the farm is up; the settle close publishes is the farm stopping.
  private async settled(aborted: boolean) {
    if (aborted && !this.closing) this.journal.note("run/error", "主人叫停了");
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
      await this.o.go(this.execution.observe(e, run)).catch((err: Error) => this.o.notice("error", this.o.label + "的执行没能记下：" + err.message));
    switch (e.type) {
      case "message_start":
        if (isHosted(e.message, this.o.inputType)) {
          const next = this.local.get(e.message) ?? { route: e.message.details as R, run: { by: { kind: "" } } };
          // An input that joins the run takes the words from here on: the one before has what it got, and ends now, or a
          // caller waiting on it (a brief, a call's line) would wait for the run's end with no words.
          if (this.input.caller && this.input.caller !== next.caller) this.input.caller.end();
          this.input = next;
          this.toCaller = 0;
        }
        return;
      case "agent_start":
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
        if (m.stopReason === "error") this.o.notice("error", this.o.label + "出错了：" + (m.errorMessage || "模型出错了"));
        return;
      }
      case "compaction_end":
        if (e.usage) {
          const tokens = tokensOf(e.usage);
          this.journal.usage(tokens, "整理对话，" + usageText(tokens));
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

const isHosted = (m: AgentMessage, inputType: string): m is CustomMessage => m.role === "custom" && (m as CustomMessage).customType === inputType;

/** The input that began the turn asked: logged when the input is taken, after it was made, so the message is no newer
 * than the step, and it holds the step's words (trimmed and maybe cut; the message puts what the owner adds before them).
 * Of those, the newest: an older one with the same words was taken before. -1 when none is. */
export function turnAt(lines: readonly AgentMessage[], text: string, time: number, inputType: string): number {
  const head = text.endsWith("…") ? text.slice(0, -1) : text;
  let at = -1;
  lines.forEach((m, i) => {
    if (isHosted(m, inputType) && m.timestamp <= time && messageText(m).includes(head) && (at < 0 || m.timestamp >= lines[at]!.timestamp)) at = i;
  });
  return at;
}

/** What followed an input until the next one, without the compactions written after a run. */
export function turnOf(rest: readonly AgentMessage[], inputType: string): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const m of rest) {
    if (isHosted(m, inputType)) break;
    if (m.role !== "compactionSummary") out.push(m);
  }
  return out;
}
