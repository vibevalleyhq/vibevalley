// One agent loop (agent_start to agent_end) is one run: it starts when the loop takes its first input and ends with the loop; a loop
// that takes inputs for several issues keeps the first in session_run.issue and links all of them in session_run_issue.
// An input still queued is not linked. A run whose end could not be written stays ending: the next input waits for it.

import { Effect, Schema } from "effect";

import type { CoreEvent } from "@vibevalley/agent/brain";
import type { ToolResult } from "@vibevalley/agent/core/loop";
import { messageText } from "@vibevalley/agent/messages";
import { t } from "@vibevalley/i18n";
import type { Outcome, RunTrigger } from "@vibevalley/protocol";

import { newId } from "@/base/ids.ts";
import { Inconsistent } from "@/errors.ts";

import type { ToolStart } from "./facts.ts";
import type { Journal } from "./journal.ts";
import type { NotRecorded, RunStore } from "./session.ts";

/** What an input starts a run with; attached only when the loop consumes it, not when it is queued. */

/** A failed start asked while another run is still going: it is not recorded as its own run. */
export class RunBusy extends Schema.TaggedError<RunBusy, { readonly brand: unique symbol }>()("RunBusy", { message: Schema.String }) {}

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
export interface InProcessRun {
  /** The loop's events, in order; input only for a consumed input's message_start. */
  readonly observe: (e: CoreEvent, input?: RunInput) => Effect.Effect<void, NotRecorded>;
  /** A rejected input as its own failed run, without consuming another input's work. */
  readonly failedStart: (input: RunInput, text: string, reason: string) => Effect.Effect<string, NotRecorded | RunBusy>;
  /** The input of the next run, which goes on with one consumed before a restart; undefined forgets it. */
  readonly resume: (input: RunInput | undefined) => void;
  /** Ends the run going on as interrupted; takes no more events. */
  readonly close: Effect.Effect<void, NotRecorded>;
  readonly currentRun: () => string;
}

export const makeInProcessRun = (
  session: string,
  journal: Journal,
  toolStart: (tool: string, args: unknown) => ToolStart,
  store: RunStore,
): Effect.Effect<InProcessRun> =>
  Effect.sync(() => {
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

    const finish = Effect.gen(function* () {
      if (!run) return;
      ending = true;
      const issues = yield* store.issues(run);
      yield* store.finish(run, outcome, summary);
      journal.runEnded(run, outcome);
      const done = { id: run, issues, outcome };
      run = "";
      ending = false;
      store.finished(done);
    });

    const begin = Effect.fnUntraced(function* (input: RunInput) {
      if (ending) yield* finish;
      if (run) {
        if (input.issue) yield* store.link(run, input.issue);
        return;
      }
      const given = !input.issue && !input.by.kind && resuming ? resuming : input;
      resuming = undefined;
      const by: RunTrigger = given.by.kind ? given.by : { kind: "runtime" };
      const id = newId();
      yield* store.start(id, session, given.issue ?? "", by);
      if (given.issue) yield* store.link(id, given.issue);
      run = id;
      outcome = "completed";
      summary = "";
      heard = [];
      journal.runStarted(id);
    });
    const going = begin({ by: { kind: "" } });

    const observe = Effect.fnUntraced(function* (e: CoreEvent, input?: RunInput) {
      if (closed) return;
      if (input) {
        // The loop hands a consumed input with the message_start it opened: anything else is a bug in the host.
        if (e.type !== "message_start") return yield* Effect.die(new Inconsistent({ message: "run input requires a message start" }));
        yield* begin(input);
        if (input.heard && input.heard.length > 0) {
          heard = [...new Set([...heard, ...input.heard])];
          yield* store.heard(run, heard);
          store.consumed({ session, messages: [...input.heard] });
        }
        journal.asked(input.asked || messageText(e.message));
      }
      switch (e.type) {
        case "agent_end": {
          const last = e.messages.at(-1);
          if (last?.role === "assistant" && last.stopReason === "aborted" && !ending) outcome = "interrupted";
          return yield* finish;
        }
        case "message_end": {
          const m = e.message;
          if (m.role !== "assistant") return;
          yield* going;
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
          yield* going;
          journal.toolStarted(e.toolCallId, toolStart(e.toolName, e.args));
          return;
        case "tool_execution_end":
          yield* going;
          journal.toolEnded(e.toolCallId, resultText(e.result), !e.isError);
          return;
        default:
          break;
      }
    });

    const failedStart = Effect.fnUntraced(function* (input: RunInput, text: string, reason: string) {
      if (closed) return "";
      if (run && !ending) return yield* new RunBusy({ message: "another in-process run is still running" });
      yield* begin(input);
      journal.asked(text);
      outcome = "failed";
      summary = reason;
      journal.note("run/error", reason);
      const id = run;
      yield* finish;
      return id;
    });

    const close = Effect.suspend(() => {
      closed = true;
      if (run && !ending) {
        outcome = "interrupted";
        summary = t("server.session.log.stopped");
      }
      return finish;
    });

    return {
      observe,
      failedStart,
      resume: (input) => {
        resuming = input;
      },
      close,
      currentRun,
    } satisfies InProcessRun;
  });
