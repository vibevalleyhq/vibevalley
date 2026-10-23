// The tagged errors the API answers with (@vibevalley/protocol/api), made where a service refuses.

import type { ApiError, Next } from "@vibevalley/protocol/api";

export type { ApiError, Next };

export const refused = (reason: string, next?: readonly Next[]): ApiError => ({ _tag: "Refused", reason, ...(next && next.length > 0 ? { next } : {}) });

/** Something asked for by id or name is not there. next is required: where to look for the ones that are (lookIn). */
export const missing = (what: string, next: readonly Next[]): ApiError => ({ _tag: "Missing", what, ...(next.length > 0 ? { next } : {}) });

/** Where to find the ones that are there, as the command that lists them; cli.test.ts runs each one's help, so a command
 * renamed away breaks the test, not the hint. */
export const lookIn = {
  issue: { say: "列出工单，找它的编号", run: ["issue", "list"] },
  session: { say: "列出帮工，找它的 id", run: ["session", "list"] },
  project: { say: "列出项目，找它的名字", run: ["project", "list"] },
  runtime: { say: "列出农机，找它的 id", run: ["runtime", "list"] },
  doc: { say: "列出文档，找它的 id", run: ["doc", "list"] },
  agent: { say: "列出档案，找它的 id", run: ["agent", "list"] },
  skill: { say: "列出技能，找它的 id", run: ["skill", "list"] },
  recurrence: { say: "列出定时，找它的 id", run: ["recurrence", "list"] },
  device: { say: "看连着的设备，找它的 id", run: ["lan", "status"] },
  archive: { say: "列出管家的旧账", run: ["orchestrator", "list-archive"] },
  // Channels, conversations and task graphs have no list of their own: they are in the core state.
  channel: { say: "频道和对话在核心状态的 state.chat 里", run: ["state"] },
  graph: { say: "计划在核心状态的 graphs 里", run: ["state"] },
} as const satisfies Record<string, Next>;

/** Where an agent's memories are listed. */
export const memoriesOf = (agent: string): Next => ({ say: "列出它的记性，找那一条的 id", run: ["memory", "list", agent] });

/** An error's words, whatever its tag. */
export const reasonOf = (e: ApiError): string =>
  "reason" in e && typeof e.reason === "string" ? e.reason : "what" in e && typeof e.what === "string" ? e.what : e._tag;
