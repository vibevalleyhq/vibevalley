// What a run cost and said. One run takes in its tool turns and the inputs that came while it went on.

import { type AssistantMessage, type Usage, zeroUsage } from "../../ai/messages.ts";
import { messageText } from "./messages.ts";

/** usage leaves out earlier runs; contextTokens is the newest request's. */
export interface RunResult {
  readonly id: number;
  readonly usage: Usage;
  readonly contextTokens: number;
  readonly text: string;
  readonly aborted: boolean;
  /** The model's request failed; error is what it said of it, "" when it said nothing. */
  readonly failed: boolean;
  readonly error: string;
  readonly settled: boolean;
}

/** current takes in what an unfinished answer has used so far; lifetime is this agent's, not its loaded transcript's. */
export interface RunSnapshot {
  readonly current: RunResult;
  readonly lifetime: Usage;
}

export function addUsage(a: Usage, b: Usage): Usage {
  const sum: Usage = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
  return a.reasoning !== undefined || b.reasoning !== undefined ? { ...sum, reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) } : sum;
}

const blank = (id: number): RunResult => ({
  id,
  usage: zeroUsage(),
  contextTokens: 0,
  text: "",
  aborted: false,
  failed: false,
  error: "",
  settled: false,
});

export class RunAccounting {
  current: RunResult = blank(0);
  private previous = zeroUsage();
  private pending = zeroUsage();

  active() {
    return this.current.id !== 0 && !this.current.settled;
  }

  begin() {
    if (this.active()) return;
    this.previous = addUsage(this.previous, this.current.usage);
    this.current = blank(this.current.id + 1);
    this.pending = zeroUsage();
  }

  partial(m: AssistantMessage) {
    if (!this.active()) this.begin();
    this.pending = m.usage ? { ...m.usage, cost: { ...m.usage.cost } } : zeroUsage();
    this.current = { ...this.current, contextTokens: contextOf(m) };
  }

  message(m: AssistantMessage) {
    if (!this.active()) this.begin();
    this.pending = zeroUsage();
    const text = messageText(m).trim();
    this.current = {
      ...this.current,
      usage: addUsage(this.current.usage, m.usage ?? zeroUsage()),
      contextTokens: contextOf(m),
      text: text !== "" ? text : this.current.text,
      failed: m.stopReason === "error",
      error: m.stopReason === "error" ? (m.errorMessage ?? "") : "",
      aborted: m.stopReason === "aborted",
    };
  }

  /** A user's or another input's words: the run's answer is what comes after them. */
  heard() {
    this.current = { ...this.current, text: "" };
  }

  snapshot(): RunSnapshot {
    const current = { ...this.current, usage: addUsage(this.current.usage, this.pending) };
    return { current, lifetime: addUsage(this.previous, current.usage) };
  }

  settle(aborted: boolean): RunResult {
    this.current = {
      ...this.current,
      usage: addUsage(this.current.usage, this.pending),
      aborted: this.current.aborted || aborted,
      settled: true,
    };
    this.pending = zeroUsage();
    return this.snapshot().current;
  }
}

const contextOf = (m: AssistantMessage) => (m.usage ? m.usage.input + m.usage.cacheRead + m.usage.output : 0);
