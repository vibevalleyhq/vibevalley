import type { CoreEvent } from "@vibevalley/agent/brain";
import type { ToolResult } from "@vibevalley/agent/core/loop";
import { messageText } from "@vibevalley/agent/messages";
import type { Clock } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type { Outcome, RunTrigger, Spent } from "@vibevalley/protocol";
import { issueId } from "@vibevalley/protocol/schema";

import { Inconsistent } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { jsonText } from "#/base/json.ts";
import { causeMessage, type Db, SqlError } from "#/infra/db.ts";
import * as qr from "#db/session_run.sql.ts";
import * as qi from "#db/session_run_issue.sql.ts";

import type { Journal } from "./journal.ts";
import type { ToolStart } from "./reaction.ts";
import type { RunStore } from "./registry.ts";

/** A failed start asked while another run is still going: it is not recorded as its own run. */
export class RunBusy extends Error {
  override readonly name = "RunBusy";
}

/** A run's record that could not be written: the run's end is tried again before another input is taken. */
export class NotRecorded extends Error {
  override readonly name = "NotRecorded";
}

/** What an input starts a run with; attached only when the loop consumes it, not when it is queued. */
export interface RunInput {
  readonly issue?: string;
  readonly by: RunTrigger | { readonly kind: "" };
  readonly heard?: readonly string[];
  /** What the log shows was asked; the message's text when empty. */
  readonly asked?: string;
}

/** A tool result's text. */
const resultText = (result: ToolResult) => result.content.flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n");

/** The run of an in-process agent, fed the loop's events. */
interface InProcessRun {
  /** The loop's events, in order; input only for a consumed input's message_start. */
  readonly observe: (e: CoreEvent, input?: RunInput) => Promise<void>;
  /** A rejected input as its own failed run, without consuming another input's work; NotRecorded or RunBusy when it cannot be. */
  readonly failedStart: (input: RunInput, text: string, reason: string) => Promise<string>;
  /** The input of the next run, which goes on with one consumed before a restart; undefined forgets it. */
  readonly resume: (input: RunInput | undefined) => void;
  /** Goes on with run, recorded and not ended before a restart, as the run under way. */
  readonly adopt: (run: string) => void;
  /** Ends the run going on as interrupted; takes no more events from when it is called. */
  readonly close: () => Promise<void>;
  /** Takes no more events and leaves the run going on open, for the next start to adopt. */
  readonly leave: () => void;
  readonly currentRun: () => string;
}

export function makeInProcessRun(session: string, journal: Journal, toolStart: (tool: string, args: unknown) => ToolStart, store: RunStore): InProcessRun {
  let run = "";
  let outcome: Outcome = "completed";
  let summary = "";
  let heard: string[] = [];
  let closed = false;
  /** The input a restarted agent's run goes on with: consumed before the restart, so no event of the run carries it. */
  let resuming: RunInput | undefined;
  /** The end could not be written: retried before anything else, and the run takes no more inputs. */
  let ending = false;
  const currentRun = () => (ending ? "" : run);
  store.register(session, currentRun);

  const finish = async () => {
    if (!run) return;
    ending = true;
    const issues = await store.issues(run);
    await store.finish(run, outcome, summary);
    journal.runEnded(run, outcome);
    const done = { id: run, issues, outcome };
    run = "";
    ending = false;
    store.finished(done);
  };

  const begin = async (input: RunInput) => {
    if (ending) await finish();
    if (run) {
      if (input.issue) await store.link(run, input.issue);
      return;
    }
    const given = !input.issue && !input.by.kind && resuming ? resuming : input;
    resuming = undefined;
    const by: RunTrigger = given.by.kind ? given.by : { kind: "runtime" };
    const id = newId();
    await store.start(id, session, given.issue ?? "", by);
    if (given.issue) await store.link(id, given.issue);
    run = id;
    outcome = "completed";
    summary = "";
    heard = [];
    journal.runStarted(id);
  };
  /** A run for what the loop does without an input: the one going on, or one started for it. */
  const going = () => begin({ by: { kind: "" } });

  const observe = async (e: CoreEvent, input?: RunInput) => {
    if (closed) return;
    if (input) {
      // The loop hands a consumed input with the message_start it opened: anything else is a bug in the host.
      if (e.type !== "message_start") throw new Inconsistent("run input requires a message start");
      await begin(input);
      if (input.heard && input.heard.length > 0) {
        heard = [...new Set([...heard, ...input.heard])];
        await store.heard(run, heard);
        store.consumed({ session, envelopeIds: [...input.heard] });
      }
      journal.asked(input.asked || messageText(e.message));
    }
    switch (e.type) {
      case "agent_end": {
        const last = e.messages.at(-1);
        if (last?.role === "assistant" && last.stopReason === "aborted" && !ending) outcome = "interrupted";
        return finish();
      }
      case "message_end": {
        const m = e.message;
        if (m.role !== "assistant") return;
        await going();
        for (const part of m.content) if (part.type === "thinking" && part.thinking) journal.thought(part.thinking);
        const text = messageText(m).trim();
        journal.said(text);
        summary = text;
        if (m.stopReason === "error") {
          outcome = "failed";
          summary = m.errorMessage || t("server.agent.modelFailed");
          journal.note("run/error", summary);
        } else if (m.stopReason === "aborted") outcome = "interrupted";
        return;
      }
      case "tool_execution_start":
        await going();
        journal.toolStarted(e.toolCallId, toolStart(e.toolName, e.args));
        return;
      case "tool_execution_end":
        await going();
        journal.toolEnded(e.toolCallId, resultText(e.result), !e.isError);
        return;
      default:
        break;
    }
  };

  const failedStart = async (input: RunInput, text: string, reason: string) => {
    if (closed) return "";
    if (run && !ending) throw new RunBusy("another in-process run is still running");
    await begin(input);
    journal.asked(text);
    outcome = "failed";
    summary = reason;
    journal.note("run/error", reason);
    const id = run;
    await finish();
    return id;
  };

  const close = () => {
    closed = true;
    if (run && !ending) {
      outcome = "interrupted";
      summary = t("server.session.log.stopped");
    }
    return finish();
  };

  return {
    observe,
    failedStart,
    resume: (input) => {
      resuming = input;
    },
    adopt: (id) => {
      run = id;
      journal.runResumed(id);
      outcome = "completed";
      summary = "";
      heard = [];
    },
    close,
    leave: () => {
      closed = true;
    },
    currentRun,
  };
}

/** The session's runs as the table keeps them; a write the database refuses is NotRecorded. */
export function recording(deps: { readonly db: Db; readonly clock: Clock }) {
  const { db, clock } = deps;
  const tried = async <A>(write: () => Promise<A>): Promise<A> => {
    try {
      return await write();
    } catch (e) {
      if (e instanceof SqlError) throw new NotRecorded(causeMessage(e), { cause: e });
      throw e;
    }
  };
  return {
    // The times are read as each is asked for, before the row is written; a caller that queues the write passes the
    // time the run started, so an input consumed meanwhile is never dated before its run.
    start: async (id: string, session: string, issue: string, trigger: RunTrigger, at = clock.now()) => {
      await tried(() => qr.startRun(db.sql, { id, session, issue: issue || null, triggered_by: jsonText(trigger), started_at: at }));
    },
    link: async (run: string, issue: string) => {
      await tried(() => qi.linkRunIssue(db.sql, { run, issue }));
    },
    heard: async (id: string, heard: readonly string[]) => {
      await tried(() => qr.heardInRun(db.sql, { heard: jsonText(heard), id }));
    },
    issues: async (run: string) => (await tried(() => qi.runIssues(db.sql, { run }))).map((row) => issueId(row.issue)),
    /** The session's run not ended yet: at most one, left open by a restart. */
    unended: async (session: string) => {
      const row = (await tried(() => qr.openRuns(db.sql))).findLast((r) => r.session === session);
      return row === undefined ? undefined : { id: row.id, startedAt: row.started_at };
    },
    finish: async (id: string, outcome: Outcome, summary: string, spent?: Spent) => {
      const at = clock.now();
      await tried(() => qr.endRun(db.sql, { ended_at: at, outcome, summary: summary || null, spent: spent ? jsonText(spent) : null, id }));
    },
  };
}
