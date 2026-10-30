// A session's log, written to events/<id>.json: what is written is never rewritten, later steps only follow it, and the step
// still being written (the draft) is on disk only once it is sealed. A step that grows (text still streaming in, a tool that
// has not returned) is pushed again under the same number.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type { EventTokens, Outcome, SessionEvent, SessionEventType } from "@vibevalley/protocol";
import { SessionEvent as SessionEventSchema } from "@vibevalley/protocol/schema";

import { cut } from "@/base/clip.ts";
import { FileWriter } from "@/base/files.ts";
import type { Time } from "@/base/time.ts";

import type { From, ToolStart } from "./facts.ts";

const keepEvents = 240;
const textMax = 6000;
export const askedMax = 2000;
// Logs are looked back on after the session has gone, so a tool's input and output keep enough to tell what happened.
const inputMax = 4000;
// A tool's output keeps its start and its end: a test run's verdict is at the bottom.
const outputHead = 2000;
const outputTail = 4000;
const pushAfterMs = 300;
const saveAfterMs = 1500;
const decodeEvents = Schema.decodeUnknownSync(Schema.Array(SessionEventSchema));

export function clipOutput(text: string): string {
  const n = text.length;
  if (n <= outputHead + outputTail + 40) return text;
  return `${text.slice(0, outputHead)}\n${t("server.session.log.clipped", { n: n - outputHead - outputTail })}\n${text.slice(n - outputTail)}`;
}

export function readJournal(file: string): SessionEvent[] | undefined {
  if (!existsSync(file)) return undefined;
  let body: string;
  try {
    body = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return [...decodeEvents(JSON.parse(body))];
  } catch {
    // Persisted shapes have no compatibility path: the next run starts a new current-format log.
    try {
      unlinkSync(file);
    } catch {
      // Another reader may already have removed it.
    }
    return undefined;
  }
}

const callKey = (from: From | undefined, callId: string) => (from ?? []).join("/") + "|" + callId;
const who = (from: From | undefined) => (from ?? []).join("/");

export class Journal {
  private steps: SessionEvent[];
  private next = 0;
  /** Tool calls not yet returned; started is every call started (a sub-agent's steps go under the call that started it). */
  private readonly calls = new Map<string, number>();
  private readonly started = new Map<string, number>();
  /** The step still being written: pushed live, but not in steps (nor on disk) until sealed. */
  private draft: SessionEvent | undefined;
  private draftWho = "";
  private draftCall = "";
  private dirty: number[] = [];
  /** What cancels the pending push and the pending save. */
  private pushing: (() => void) | undefined;
  private saving: (() => void) | undefined;
  private closed = false;
  /** The open run the events belong to. */
  private run: string | undefined;
  private readonly disk: FileWriter;

  private readonly file: string;
  private readonly push: (e: SessionEvent) => void;
  /** Where a save that failed is said: the service's logger. */
  private readonly warn: (message: string) => void;
  /** The service's Clock: the steps' times and the push and save windows. */
  private readonly time: Time;
  private readonly keep: number;

  constructor(
    file: string,
    initial: readonly SessionEvent[],
    push: (e: SessionEvent) => void,
    warn: (message: string) => void,
    time: Time,
    keep: number = keepEvents,
  ) {
    this.file = file;
    this.push = push;
    this.warn = warn;
    this.time = time;
    this.keep = keep;
    this.disk = new FileWriter(file);
    this.steps = [...initial];
    const last = this.steps.at(-1);
    if (last) this.next = last.seq + 1;
  }

  events() {
    return [...this.steps, ...(this.draft ? [{ ...this.draft }] : [])];
  }

  private body = () => JSON.stringify(this.steps);

  private flush = () => {
    this.pushing?.();
    this.pushing = undefined;
    const out = this.dirty.flatMap((n) => {
      const step = this.steps.findLast((s) => s.seq === n) ?? (this.draft?.seq === n ? this.draft : undefined);
      return step ? [{ ...step }] : [];
    });
    this.dirty = [];
    for (const step of out) this.push(step);
  };

  private changed(n: number) {
    if (this.closed) return;
    if (!this.dirty.includes(n)) this.dirty.push(n);
    this.pushing ??= this.time.after(pushAfterMs, this.flush);
    this.saving?.();
    this.saving = this.time.after(saveAfterMs, () => {
      try {
        this.disk.write(this.body);
      } catch (e) {
        this.warn(`vibevalley: could not save ${this.file}: ${String(e)}`);
      }
    });
  }

  private under(from: From | undefined): number | undefined {
    const call = from?.at(-1);
    if (!from || call === undefined) return undefined;
    return this.started.get(callKey(from.slice(0, -1), call)) ?? -1;
  }

  /** The next seq, the time, the call it is under and the open run. */
  private stamp(step: Omit<SessionEvent, "seq" | "revision" | "time">, from: From | undefined): SessionEvent {
    const under = this.under(from);
    const out: SessionEvent = {
      seq: this.next++,
      revision: 0,
      time: this.time.now(),
      ...step,
      ...(under !== undefined ? { under } : {}),
      ...(this.run !== undefined ? { run: this.run } : {}),
    };
    return out;
  }

  /** Writes the draft, as it is, after every event before it. */
  private seal() {
    if (!this.draft) return;
    const d = this.draft;
    this.draft = undefined;
    this.draftWho = "";
    this.draftCall = "";
    this.append(d);
  }

  private add(step: Omit<SessionEvent, "seq" | "revision" | "time">, from?: From): number {
    this.seal();
    const s = this.stamp(step, from);
    this.append(s);
    return s.seq;
  }

  private append(step: SessionEvent) {
    this.steps.push(step);
    if (this.steps.length > this.keep) this.steps = this.steps.slice(this.steps.length - this.keep);
    this.changed(step.seq);
  }

  /** Makes e the draft, sealing the one before; it is pushed live from now on. */
  private makeDraft(e: Omit<SessionEvent, "seq" | "revision" | "time">, from: From | undefined, call: string) {
    this.seal();
    this.draft = this.stamp(e, from);
    this.draftWho = who(from);
    this.draftCall = call;
    this.changed(this.draft.seq);
  }

  /** Opens run id: every event after it is the run's until runEnded closes it with how it ended. */
  runStarted(id: string) {
    this.run = id;
    this.add({ type: "run/start", text: "" });
  }

  runEnded(id: string, outcome: Outcome) {
    if (this.run !== id) return;
    this.add({ type: "run/end", text: outcome });
    this.run = undefined;
  }

  asked(text: string, from?: From) {
    this.add({ type: "user/message", text: cut(text.trim(), askedMax) }, from);
  }

  /** Goes on with what is being said or thought, by the same one, in the draft; anything else starts a new one. */
  private runOn(kind: SessionEventType, text: string, from?: From) {
    if (!text) return;
    const d = this.draft;
    if (d && d.type === kind && this.draftWho === who(from)) {
      d.text = cut(d.text + text, textMax);
      d.revision++;
      this.changed(d.seq);
      return;
    }
    this.makeDraft({ type: kind, text: cut(text, textMax) }, from, "");
  }

  said(text: string, from?: From) {
    this.runOn("assistant/message", text, from);
  }

  thought(text: string, from?: From) {
    this.runOn("assistant/thinking", text, from);
  }

  toolStarted(callId: string, start: ToolStart, from?: From) {
    const step: Omit<SessionEvent, "seq" | "revision" | "time"> = {
      type: "tool/call",
      text: start.text,
      action: start.action,
      actionText: t(`shared.action.${start.action}`),
      tool: start.tool,
      ...(start.input ? { input: cut(start.input, inputMax) } : {}),
    };
    const key = callKey(from, callId);
    // Written once its input is known; one that came with it is.
    if (step.input !== undefined) {
      const n = this.add(step, from);
      this.calls.set(key, n);
      this.started.set(key, n);
      return;
    }
    this.makeDraft(step, from, key);
    this.calls.set(key, this.draft!.seq);
    this.started.set(key, this.draft!.seq);
  }

  toolInput(callId: string, input: string, text: string, from?: From) {
    // Only the draft takes it: a call already written is not changed (its input came too late to be in it).
    const d = this.draft;
    if (d && this.draftCall === callKey(from, callId)) {
      d.input = cut(input, inputMax);
      if (text) d.text = text;
      d.revision++;
      this.seal();
    }
  }

  toolEnded(callId: string, output: string, ok: boolean, from?: From) {
    const key = callKey(from, callId);
    const n = this.calls.get(key);
    if (n === undefined) return;
    this.calls.delete(key);
    this.add({ type: "tool/result", text: "", call: n, ok, ...(output.trim() ? { output: clipOutput(output.trimEnd()) } : {}) }, from);
  }

  note(kind: SessionEventType, text: string, from?: From) {
    this.add({ type: kind, text }, from);
  }

  /** An llm/usage: one model answer's tokens, with text to show for them. */
  usage(tokens: EventTokens, text: string, from?: From) {
    this.add({ type: "llm/usage", text, tokens }, from);
  }

  close() {
    this.seal();
    this.flush();
    this.saving?.();
    this.closed = true;
    try {
      this.disk.finish(this.body);
    } catch (e) {
      this.warn(`vibevalley: could not save ${this.file}: ${String(e)}`);
    }
  }
}

/** Nothing that leads out of the folder. */
const knownId = /^[A-Za-z0-9_-]+$/u;

/** Each session's log, events/<id>.json: the open ones in memory as they grow, the others on disk. */
export class Trajectories {
  private readonly open = new Map<string, Journal>();
  private readonly dir: string;

  private readonly push: (id: string, e: SessionEvent) => void;
  /** Where a log that could not be saved is said: the service's logger (Effect.logWarning on its fiber). */
  private readonly warn: (message: string) => void;
  /** The service's Clock, handed to every log. */
  private readonly time: Time;

  constructor(home: string, push: (id: string, e: SessionEvent) => void, warn: (message: string) => void, time: Time) {
    this.push = push;
    this.warn = warn;
    this.time = time;
    this.dir = join(home, "events");
  }

  private file = (id: string) => join(this.dir, id + ".json");

  /** A session's log, carried on from what it kept: a session back from a restart goes on where it was. */
  openLog(id: string, keep = 0): Journal {
    const j = new Journal(this.file(id), readJournal(this.file(id)) ?? [], (e) => this.push(id, e), this.warn, this.time, keep > 0 ? keep : keepEvents);
    this.open.set(id, j);
    return j;
  }

  /** Writes the log out and lets it go; it stays on disk. */
  finish(id: string) {
    const j = this.open.get(id);
    this.open.delete(id);
    j?.close();
  }

  /** A session's log, oldest first: from memory while it is open, else from disk; a run's only when run is given. */
  events(id: string, run = ""): SessionEvent[] | undefined {
    if (!knownId.test(id)) return undefined;
    const all = this.open.get(id)?.events() ?? readJournal(this.file(id)) ?? [];
    return run ? all.filter((e) => e.run === run) : all;
  }

  /** Deletes a session's log; who it was stays in the table. */
  forget(id: string) {
    if (knownId.test(id) && existsSync(this.file(id))) unlinkSync(this.file(id));
  }

  close() {
    for (const id of [...this.open.keys()]) this.finish(id);
  }
}
