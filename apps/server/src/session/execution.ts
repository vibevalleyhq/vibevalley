// The run of an in-process agent (the orchestrator's) and its log. One agent loop
// (agent_start to agent_end) is one run: it starts when the loop takes its first input and ends with the loop; a loop
// that takes inputs for several issues keeps the first in session_run.issue and links all of them in session_run_issue.
// An input still queued is not linked. A run whose end could not be written stays ending: the next input waits for it.

import { sessionWording } from "./words.ts";
import { agentWording } from "../agent/words.ts";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { messageText } from "../agent/brain/messages.ts";
import type { Outcome, RunTrigger } from "@vibevalley/protocol";
import { Effect } from "effect";
import { newId } from "../base/ids.ts";
import type { ToolStart } from "./facts.ts";
import type { Journal } from "./journal.ts";
import type { RunStore } from "./session.ts";

/** What an input starts a run with; attached only when the loop consumes it, not when it is queued. */
export interface RunInput {
  readonly issue?: string;
  readonly by: RunTrigger | { readonly kind: "" };
  readonly heard?: readonly string[];
  /** What the log shows was asked; the message's text when empty. */
  readonly asked?: string;
}

interface Part {
  readonly type: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly redacted?: boolean;
}

interface Message {
  readonly role: string;
  readonly content?: string | readonly Part[];
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

/** A tool result's text. */
const resultText = (result: unknown) => {
  const content = (result as { content?: readonly Part[] } | undefined)?.content ?? [];
  return content.flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n");
};

export class AgentExecution {
  private run = "";
  private outcome: Outcome = "completed";
  private summary = "";
  private heard: string[] = [];
  private closed = false;
  /** The input a restarted agent's run goes on with: consumed before the restart, so no event of the run carries it. */
  private resuming: RunInput | undefined;
  /** The end could not be written: retried before anything else, and the run takes no more inputs. */
  private ending = false;

  constructor(
    private readonly session: string,
    private readonly journal: Journal,
    private readonly toolStart: (tool: string, args: unknown) => ToolStart,
    private readonly store: RunStore,
  ) {
    store.register(session, () => this.currentRun());
  }

  private begin(input: RunInput) {
    const self = this;
    return Effect.gen(function* () {
      if (self.ending) yield* self.finish();
      if (self.run) {
        if (input.issue) yield* self.store.link(self.run, input.issue);
        return;
      }
      let given = input;
      if (!given.issue && !given.by.kind && self.resuming) given = self.resuming;
      self.resuming = undefined;
      const by: RunTrigger = given.by.kind ? given.by : { kind: "runtime" };
      const id = newId();
      yield* self.store.start(id, self.session, given.issue ?? "", by);
      if (given.issue) yield* self.store.link(id, given.issue);
      self.run = id;
      self.outcome = "completed";
      self.summary = "";
      self.heard = [];
      self.journal.runStarted(id);
    });
  }

  private finish() {
    const self = this;
    return Effect.gen(function* () {
      if (!self.run) return;
      self.ending = true;
      const issues = yield* self.store.issues(self.run);
      yield* self.store.finish(self.run, self.outcome, self.summary);
      self.journal.runEnded(self.run, self.outcome);
      const done = { id: self.run, issues, outcome: self.outcome };
      self.run = "";
      self.ending = false;
      self.store.finished(done);
    });
  }

  /** The loop's events, in order; input only for a consumed input's message_start. */
  observe(e: AgentEvent, input?: RunInput): Effect.Effect<void, Error> {
    const self = this;
    return Effect.gen(function* () {
      if (self.closed) return;
      if (input) {
        if (e.type !== "message_start") return yield* Effect.fail(new Error("run input requires a message start"));
        yield* self.begin(input);
        if (input.heard && input.heard.length > 0) {
          for (const id of input.heard) if (!self.heard.includes(id)) self.heard.push(id);
          yield* self.store.heard(self.run, self.heard);
          self.store.consumed({ session: self.session, messages: [...input.heard] });
        }
        self.journal.asked(input.asked || messageText(e.message));
      }
      switch (e.type) {
        case "agent_end": {
          const last = e.messages.at(-1) as Message | undefined;
          if (last?.role === "assistant" && last.stopReason === "aborted" && !self.ending) self.outcome = "interrupted";
          return yield* self.finish();
        }
        case "message_end": {
          const m = e.message as Message;
          if (m.role !== "assistant") return;
          yield* self.begin({ by: { kind: "" } });
          for (const part of typeof m.content === "string" ? [] : (m.content ?? []))
            if (part.type === "thinking" && !part.redacted && part.thinking) self.journal.thought(part.thinking);
          const text = messageText(e.message).trim();
          self.journal.said(text);
          self.summary = text;
          if (m.stopReason === "error") {
            self.outcome = "failed";
            self.summary = m.errorMessage || agentWording().modelFailed;
            self.journal.note("run/error", self.summary);
          } else if (m.stopReason === "aborted") self.outcome = "interrupted";
          return;
        }
        case "tool_execution_start":
          yield* self.begin({ by: { kind: "" } });
          self.journal.toolStarted(e.toolCallId, self.toolStart(e.toolName, e.args));
          return;
        case "tool_execution_end":
          yield* self.begin({ by: { kind: "" } });
          self.journal.toolEnded(e.toolCallId, resultText(e.result), !e.isError);
          return;
        default:
          break;
      }
    });
  }

  /** A rejected input as its own failed run, without consuming another input's work. */
  failedStart(input: RunInput, text: string, reason: string): Effect.Effect<string, Error> {
    const self = this;
    return Effect.gen(function* () {
      if (self.closed) return "";
      if (self.run && !self.ending) return yield* Effect.fail(new Error("another agent execution is still running"));
      yield* self.begin(input);
      self.journal.asked(text);
      self.outcome = "failed";
      self.summary = reason;
      self.journal.note("run/error", reason);
      const id = self.run;
      yield* self.finish();
      return id;
    });
  }

  /** The input of the next run, which goes on with one consumed before a restart; undefined forgets it. */
  resume(input: RunInput | undefined) {
    this.resuming = input;
  }

  close(): Effect.Effect<void, Error> {
    return Effect.suspend(() => {
      this.closed = true;
      if (this.run && !this.ending) {
        this.outcome = "interrupted";
        this.summary = sessionWording().log.stopped;
      }
      return this.finish();
    });
  }

  currentRun() {
    return this.ending ? "" : this.run;
  }
}
