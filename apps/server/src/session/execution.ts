// The run of an in-process agent (the orchestrator's) and its log. One agent loop
// (agent_start to agent_end) is one run: it starts when the loop takes its first input and ends with the loop; a loop
// that takes inputs for several issues keeps the first in session_run.issue and links all of them in session_run_issue.
// An input still queued is not linked. A run whose end could not be written stays ending: the next input waits for it.

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

  private begin = Effect.fn({ self: this }, function* (this: AgentExecution, input: RunInput): Effect.fn.Return<void, Error> {
    if (this.ending) yield* this.finish();
    if (this.run) {
      if (input.issue) yield* this.store.link(this.run, input.issue);
      return;
    }
    let given = input;
    if (!given.issue && !given.by.kind && this.resuming) given = this.resuming;
    this.resuming = undefined;
    const by: RunTrigger = given.by.kind ? (given.by as RunTrigger) : { kind: "runtime" };
    const id = newId();
    yield* this.store.start(id, this.session, given.issue ?? "", by);
    if (given.issue) yield* this.store.link(id, given.issue);
    this.run = id;
    this.outcome = "completed";
    this.summary = "";
    this.heard = [];
    this.journal.runStarted(id);
  });

  private finish = Effect.fn({ self: this }, function* (this: AgentExecution): Effect.fn.Return<void, Error> {
    if (!this.run) return;
    this.ending = true;
    const issues = yield* this.store.issues(this.run);
    yield* this.store.finish(this.run, this.outcome, this.summary);
    this.journal.runEnded(this.run, this.outcome);
    const done = { id: this.run, issues, outcome: this.outcome };
    this.run = "";
    this.ending = false;
    this.store.finished(done);
  });

  /** The loop's events, in order; input only for a consumed input's message_start. */
  observe = Effect.fn({ self: this }, function* (this: AgentExecution, e: AgentEvent, input?: RunInput): Effect.fn.Return<void, Error> {
    if (this.closed) return;
    if (input) {
      if (e.type !== "message_start") return yield* Effect.fail(new Error("run input requires a message start"));
      yield* this.begin(input);
      if (input.heard && input.heard.length > 0) {
        for (const id of input.heard) if (!this.heard.includes(id)) this.heard.push(id);
        yield* this.store.heard(this.run, this.heard);
        this.store.consumed({ session: this.session, messages: [...input.heard] });
      }
      this.journal.asked(input.asked || messageText(e.message));
    }
    switch (e.type) {
      case "agent_end": {
        const last = e.messages.at(-1) as Message | undefined;
        if (last?.role === "assistant" && last.stopReason === "aborted" && !this.ending) this.outcome = "interrupted";
        return yield* this.finish();
      }
      case "message_end": {
        const m = e.message as Message;
        if (m.role !== "assistant") return;
        yield* this.begin({ by: { kind: "" } });
        for (const part of typeof m.content === "string" ? [] : (m.content ?? []))
          if (part.type === "thinking" && !part.redacted && part.thinking) this.journal.thought(part.thinking);
        const text = messageText(e.message).trim();
        this.journal.said(text);
        this.summary = text;
        if (m.stopReason === "error") {
          this.outcome = "failed";
          this.summary = m.errorMessage || "模型出错了";
          this.journal.note("run/error", this.summary);
        } else if (m.stopReason === "aborted") this.outcome = "interrupted";
        return;
      }
      case "tool_execution_start":
        yield* this.begin({ by: { kind: "" } });
        this.journal.toolStarted(e.toolCallId, this.toolStart(e.toolName, e.args));
        return;
      case "tool_execution_end":
        yield* this.begin({ by: { kind: "" } });
        this.journal.toolEnded(e.toolCallId, resultText(e.result), !e.isError);
        return;
    }
  });

  /** A rejected input as its own failed run, without consuming another input's work. */
  failedStart = Effect.fn({ self: this }, function* (this: AgentExecution, input: RunInput, text: string, reason: string): Effect.fn.Return<string, Error> {
    if (this.closed) return "";
    if (this.run && !this.ending) return yield* Effect.fail(new Error("another agent execution is still running"));
    yield* this.begin(input);
    this.journal.asked(text);
    this.outcome = "failed";
    this.summary = reason;
    this.journal.note("run/error", reason);
    const id = this.run;
    yield* this.finish();
    return id;
  });

  /** The input of the next run, which goes on with one consumed before a restart; undefined forgets it. */
  resume(input: RunInput | undefined) {
    this.resuming = input;
  }

  close = Effect.fn({ self: this }, function* (this: AgentExecution): Effect.fn.Return<void, Error> {
    this.closed = true;
    if (this.run && !this.ending) {
      this.outcome = "interrupted";
      this.summary = "VibeValley 停下了，这一轮中断了";
    }
    yield* this.finish();
  });

  currentRun() {
    return this.ending ? "" : this.run;
  }
}
