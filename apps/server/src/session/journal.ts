// A session's log, written to events/<id>.json: what is written is never rewritten, later steps only follow it, and the step
// still being written (the draft) is on disk only once it is sealed. A step that grows (text still streaming in, a tool that
// has not returned) is pushed again under the same number.

import { join } from "node:path";

import { Effect, Exit, FileSystem, Schema, Scope } from "effect";

import { t } from "@vibevalley/i18n";
import type { EventTokens, Outcome, SessionEvent, SessionEventType } from "@vibevalley/protocol";
import { cut } from "@vibevalley/protocol/rules";
import { SessionEvent as SessionEventSchema } from "@vibevalley/protocol/schema";

import { type KeptFile, keptFile } from "@/infra/files.ts";
import { type Time, timeHere } from "@/infra/time.ts";

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

function clipOutput(text: string): string {
  const n = text.length;
  if (n <= outputHead + outputTail + 40) return text;
  return `${text.slice(0, outputHead)}\n${t("server.session.log.clipped", { n: n - outputHead - outputTail })}\n${text.slice(n - outputTail)}`;
}

/** A log kept on disk; none when there is none. One not in today's shape is deleted: persisted shapes have no
 * compatibility path, and the next run starts a new current-format log. */
export const readJournal = (file: string): Effect.Effect<SessionEvent[] | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const body = yield* Effect.option(fs.readFileString(file));
    if (body._tag === "None") return undefined;
    const events = yield* Effect.option(Effect.try(() => [...decodeEvents(JSON.parse(body.value))]));
    if (events._tag === "Some") return events.value;
    // Another reader may already have removed it.
    yield* Effect.ignore(fs.remove(file));
    return undefined;
  });

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
  /** What cancels the pending push. */
  private pushing: (() => void) | undefined;
  private closed = false;
  /** The open run the events belong to. */
  private run: string | undefined;
  /** events/<id>.json, written a moment after the steps change and once more as the log closes. */
  private readonly disk: KeptFile;
  private readonly push: (e: SessionEvent) => void;
  /** The service's Clock: the steps' times and the push window. */
  private readonly time: Time;
  private readonly keep: number;

  constructor(disk: KeptFile, initial: readonly SessionEvent[], push: (e: SessionEvent) => void, time: Time, keep: number = keepEvents) {
    this.disk = disk;
    this.push = push;
    this.time = time;
    this.keep = keep;
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
    this.disk.soon(this.body);
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

  /** Seals what is being written; the log's scope, closed after this, writes it out. */
  close() {
    this.seal();
    this.flush();
    this.disk.soon(this.body);
    this.closed = true;
  }
}

/** Nothing that leads out of the folder. */
const knownId = /^[A-Za-z0-9_-]+$/u;

/** Each session's log, events/<id>.json: the open ones in memory as they grow, the others on disk. Each open log has a
 * scope of its own under the service's: closing it writes the log out, and the service's end closes those still open. */
export interface Trajectories {
  /** A session's log, carried on from what it kept: a session back from a restart goes on where it was. */
  readonly openLog: (id: string, keep?: number) => Effect.Effect<Journal>;
  /** Writes the log out and lets it go; it stays on disk. */
  readonly finish: (id: string) => Effect.Effect<void>;
  /** A session's log, oldest first: from memory while it is open, else from disk; a run's only when run is given. */
  readonly events: (id: string, run?: string) => Effect.Effect<SessionEvent[] | undefined>;
  /** Deletes a session's log; who it was stays in the table. */
  readonly forget: (id: string) => Effect.Effect<void>;
}

export const makeTrajectories = (home: string, push: (id: string, e: SessionEvent) => void) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const time = yield* timeHere;
    const scope = yield* Effect.scope;
    const dir = join(home, "events");
    const fileOf = (id: string) => join(dir, id + ".json");
    const open = new Map<string, { readonly journal: Journal; readonly scope: Scope.Closeable }>();
    const withFs = Effect.provideService(FileSystem.FileSystem, fs);
    // The logs' scopes are made before the finalizer that seals them, so they close after it: each draft sealed first.
    const logs = yield* Scope.fork(scope);

    const finish = (id: string) =>
      Effect.suspend(() => {
        const o = open.get(id);
        open.delete(id);
        if (!o) return Effect.void;
        o.journal.close();
        return Scope.close(o.scope, Exit.void);
      });

    yield* Effect.addFinalizer(() => Effect.forEach([...open.keys()], finish, { discard: true }));

    return {
      openLog: (id, keep = 0) =>
        Effect.gen(function* () {
          // A log opened again (a session taken up again) is a new one read from disk; the one before still writes
          // what it is told until its scope, a child of the service's, closes.
          const own = yield* Scope.fork(logs);
          const disk = yield* keptFile(fileOf(id), { soonMs: saveAfterMs }).pipe(Scope.provide(own), withFs);
          const initial = (yield* withFs(readJournal(fileOf(id)))) ?? [];
          const journal = new Journal(disk, initial, (e) => push(id, e), time, keep > 0 ? keep : keepEvents);
          open.set(id, { journal, scope: own });
          return journal;
        }),
      finish,
      events: (id, run = "") =>
        Effect.gen(function* () {
          if (!knownId.test(id)) return undefined;
          const all = open.get(id)?.journal.events() ?? (yield* withFs(readJournal(fileOf(id)))) ?? [];
          return run ? all.filter((e) => e.run === run) : all;
        }),
      forget: (id) => (knownId.test(id) ? Effect.ignore(fs.remove(fileOf(id))) : Effect.void),
    } satisfies Trajectories;
  });
