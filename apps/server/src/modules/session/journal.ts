import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type { EventTokens, Outcome, SessionEvent, SessionEventType, ToolConnection } from "@vibevalley/protocol";
import { cut } from "@vibevalley/protocol/rules";
import { SessionEvent as SessionEventSchema } from "@vibevalley/protocol/schema";

import { errnoOf } from "#/base/errors.ts";
import { jsonOrNone } from "#/base/json.ts";
import { type KeptFile, keptFile } from "#/infra/files.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";

import type { From, ToolStart } from "./reaction.ts";

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
const decodeEvents = jsonOrNone(z.array(SessionEventSchema));

function clipOutput(text: string): string {
  const n = text.length;
  if (n <= outputHead + outputTail + 40) return text;
  return `${text.slice(0, outputHead)}\n${t("server.session.log.clipped", { n: n - outputHead - outputTail })}\n${text.slice(n - outputTail)}`;
}

/** A log kept on disk. none when there is none. */
export async function readJournal(file: string, log?: Logger): Promise<SessionEvent[] | undefined> {
  let body: string;
  try {
    body = await readFile(file, "utf8");
  } catch (e) {
    if (errnoOf(e) !== "ENOENT") log?.debug(`${file} could not be read`, e);
    return undefined;
  }
  const events = decodeEvents(body);
  if (events !== undefined) return events;
  // Another reader may already have removed it.
  await rm(file, { force: true }).catch((e: unknown) => log?.debug(`${file} could not be removed`, e));
  return undefined;
}

const callKey = (from: From | undefined, callId: string) => (from ?? []).join("/") + "|" + callId;
const who = (from: From | undefined) => (from ?? []).join("/");

export type Journal = ReturnType<typeof makeJournal>;

type ActiveDraft =
  | { readonly _tag: "none" }
  | { readonly _tag: "text"; readonly event: SessionEvent; readonly who: string }
  | { readonly _tag: "toolCall"; readonly event: SessionEvent; readonly callKey: string };

function makeJournal(disk: KeptFile, initial: readonly SessionEvent[], push: (e: SessionEvent) => void, time: Time, keep: number = keepEvents) {
  let steps = [...initial];
  let next = (steps.at(-1)?.seq ?? -1) + 1;
  const calls = new Map<string, number>();
  const started = new Map<string, number>();
  let draft: ActiveDraft = { _tag: "none" };
  let dirty: number[] = [];
  let pushing: (() => void) | undefined;
  let closed = false;
  let run: string | undefined;

  const currentDraft = (): SessionEvent | undefined => (draft._tag === "none" ? undefined : draft.event);

  function events() {
    const d = currentDraft();
    return [...steps, ...(d ? [{ ...d }] : [])];
  }

  const body = () => JSON.stringify(steps);

  const flush = () => {
    pushing?.();
    pushing = undefined;
    const d = currentDraft();
    const out = dirty.flatMap((n) => {
      const step = steps.findLast((s) => s.seq === n) ?? (d?.seq === n ? d : undefined);
      return step ? [{ ...step }] : [];
    });
    dirty = [];
    for (const step of out) push(step);
  };

  function changed(n: number) {
    if (closed) return;
    if (!dirty.includes(n)) dirty.push(n);
    pushing ??= time.after(pushAfterMs, flush);
    disk.soon(body);
  }

  function parentOf(from: From | undefined): number | undefined {
    const call = from?.at(-1);
    if (!from || call === undefined) return undefined;
    return started.get(callKey(from.slice(0, -1), call)) ?? -1;
  }

  /** The next seq, the time, the call it is under and the open run. */
  function stamp(step: Omit<SessionEvent, "seq" | "revision" | "time">, from: From | undefined): SessionEvent {
    const under = parentOf(from);
    const out: SessionEvent = {
      seq: next++,
      revision: 0,
      time: time.now(),
      ...step,
      ...(under !== undefined ? { under } : {}),
      ...(run !== undefined ? { run } : {}),
    };
    return out;
  }

  /** Writes the draft, as it is, after every event before it. */
  function seal() {
    if (draft._tag === "none") return;
    const d = draft.event;
    draft = { _tag: "none" };
    append(d);
  }

  function add(step: Omit<SessionEvent, "seq" | "revision" | "time">, from?: From): number {
    seal();
    const s = stamp(step, from);
    append(s);
    return s.seq;
  }

  function append(step: SessionEvent) {
    steps.push(step);
    if (steps.length > keep) steps = steps.slice(steps.length - keep);
    changed(step.seq);
  }

  /** Makes e the draft, sealing the one before; it is pushed live from now on. */
  function makeDraft(e: Omit<SessionEvent, "seq" | "revision" | "time">, from: From | undefined, call: string) {
    seal();
    const event = stamp(e, from);
    draft = call ? { _tag: "toolCall", event, callKey: call } : { _tag: "text", event, who: who(from) };
    changed(event.seq);
    return event.seq;
  }

  /** Opens run id: every event after it is the run's until runEnded closes it with how it ended. */
  function runStarted(id: string) {
    run = id;
    add({ type: "run/start", text: "" });
  }

  /** Goes on with run id, opened before a restart: its start is already in the log. */
  function runResumed(id: string) {
    run = id;
  }

  function runEnded(id: string, outcome: Outcome) {
    if (run !== id) return;
    add({ type: "run/end", text: outcome });
    run = undefined;
  }

  function asked(text: string, from?: From) {
    add({ type: "user/message", text: cut(text.trim(), askedMax) }, from);
  }

  /** Goes on with what is being said or thought, by the same one, in the draft; anything else starts a new one. */
  function runOn(kind: SessionEventType, text: string, from?: From) {
    if (!text) return;
    if (draft._tag === "text" && draft.event.type === kind && draft.who === who(from)) {
      draft.event.text = cut(draft.event.text + text, textMax);
      draft.event.revision++;
      changed(draft.event.seq);
      return;
    }
    makeDraft({ type: kind, text: cut(text, textMax) }, from, "");
  }

  function said(text: string, from?: From) {
    runOn("assistant/message", text, from);
  }

  function thought(text: string, from?: From) {
    runOn("assistant/thinking", text, from);
  }

  function toolStarted(callId: string, start: ToolStart, from?: From) {
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
      const n = add(step, from);
      calls.set(key, n);
      started.set(key, n);
      return;
    }
    const n = makeDraft(step, from, key);
    calls.set(key, n);
    started.set(key, n);
  }

  function toolInput(callId: string, input: string, text: string, from?: From) {
    // Only the draft takes it: a call already written is not changed (its input came too late to be in it).
    if (draft._tag === "toolCall" && draft.callKey === callKey(from, callId)) {
      draft.event.input = cut(input, inputMax);
      if (text) draft.event.text = text;
      draft.event.revision++;
      seal();
    }
  }

  function toolEnded(callId: string, output: string, ok: boolean, from?: From) {
    const key = callKey(from, callId);
    const n = calls.get(key);
    if (n === undefined) return;
    calls.delete(key);
    add({ type: "tool/result", text: "", call: n, ok, ...(output.trim() ? { output: clipOutput(output.trimEnd()) } : {}) }, from);
  }

  function connection(connection: ToolConnection) {
    if (connection.status === "failed" || connection.status === "cancelled")
      add({ type: "run/error", text: connection.reason ?? connection.server, connection });
  }

  function note(kind: SessionEventType, text: string, from?: From) {
    add({ type: kind, text }, from);
  }

  /** An llm/usage: one model answer's tokens, with text to show for them. */
  function usage(tokens: EventTokens, text: string, from?: From) {
    add({ type: "llm/usage", text, tokens }, from);
  }

  /** Seals what is being written; the log's file, closed after this, writes it out. */
  function close() {
    seal();
    flush();
    disk.soon(body);
    closed = true;
  }
  return { events, runStarted, runResumed, runEnded, asked, said, thought, toolStarted, toolInput, toolEnded, note, connection, usage, close };
}

/** Nothing that leads out of the folder. */
const knownId = /^[A-Za-z0-9_-]+$/u;

/** Each session's log, events/<id>.json: the open ones in memory as they grow, the others on disk. */
export interface Trajectories {
  /** A session's log, carried on from what it kept: a session back from a restart goes on where it was. */
  readonly openLog: (id: string, keep?: number) => Promise<Journal>;
  /** Writes the log out and lets it go; it stays on disk. */
  readonly finish: (id: string) => Promise<void>;
  /** A session's log, oldest first: from memory while it is open, else from disk; a run's only when run is given. */
  readonly events: (id: string, run?: string) => Promise<SessionEvent[] | undefined>;
  /** Deletes a session's log; who it was stays in the table. */
  readonly forget: (id: string) => Promise<void>;
  /** Seals and writes out every log still open. */
  readonly close: () => Promise<void>;
}

export function makeTrajectories(
  home: string,
  push: (id: string, e: SessionEvent) => void,
  deps: { readonly clock: Time; readonly log: Logger },
): Trajectories {
  const dir = join(home, "events");
  const fileOf = (id: string) => join(dir, id + ".json");
  const open = new Map<string, { readonly journal: Journal; readonly disk: KeptFile }>();

  // Each draft sealed first, then its file's last write.
  const finish = async (id: string) => {
    const o = open.get(id);
    open.delete(id);
    if (!o) return;
    o.journal.close();
    await o.disk.close();
  };

  return {
    openLog: async (id, keep = 0) => {
      // A log opened again (a session taken up again) is a new one read from disk.
      const disk = keptFile(fileOf(id), deps, { soonMs: saveAfterMs });
      const initial = (await readJournal(fileOf(id), deps.log)) ?? [];
      const journal = makeJournal(disk, initial, (e) => push(id, e), deps.clock, keep > 0 ? keep : keepEvents);
      open.set(id, { journal, disk });
      return journal;
    },
    finish,
    events: async (id, run = "") => {
      if (!knownId.test(id)) return undefined;
      const all = open.get(id)?.journal.events() ?? (await readJournal(fileOf(id), deps.log)) ?? [];
      return run ? all.filter((e) => e.run === run) : all;
    },
    forget: async (id) => {
      if (!knownId.test(id)) return;
      await rm(fileOf(id), { force: true }).catch((e: unknown) => deps.log.debug(`${id}'s log could not be removed`, e));
    },
    close: async () => {
      for (const id of [...open.keys()]) await finish(id);
    },
  };
}
