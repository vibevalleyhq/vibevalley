// The tagged errors the API answers with (@vibevalley/protocol/api), made where a service refuses.

import { gatewayWording } from "./words.ts";
import { type ApiError, commandOf, type Next } from "@vibevalley/protocol/api";

export type { ApiError, Next };

export const refused = (reason: string, next?: readonly Next[]): ApiError => ({ _tag: "Refused", reason, ...(next && next.length > 0 ? { next } : {}) });

/** Something asked for by id or name is not there. next is required: where to look for the ones that are (lookIn). */
export const missing = (what: string, next: readonly Next[]): ApiError => ({ _tag: "Missing", what, ...(next.length > 0 ? { next } : {}) });

/** Where to find the ones that are there, as the command that lists them; cli.test.ts runs each one's help, so a command
 * renamed away breaks the test, not the hint. */
// say is read when the error is made, in the locale of the moment.
const listed = (key: keyof ReturnType<typeof gatewayWording>["lookIn"], run: readonly string[]): Next => ({
  get say() {
    return gatewayWording().lookIn[key];
  },
  run: [...run],
});

export const lookIn = {
  issue: listed("issue", commandOf("issue.list")),
  session: listed("session", commandOf("session.list")),
  project: listed("project", commandOf("project.list")),
  runtime: listed("runtime", commandOf("runtime.list")),
  doc: listed("doc", commandOf("doc.list")),
  agent: listed("agent", commandOf("agent.list")),
  skill: listed("skill", commandOf("skill.list")),
  recurrence: listed("recurrence", commandOf("recurrence.list")),
  device: listed("device", commandOf("lan.get")),
  archive: listed("archive", commandOf("orchestrator.archive.list")),
  channel: listed("channel", commandOf("channel.list")),
  graph: listed("graph", commandOf("graph.list")),
} satisfies Record<string, Next>;

/** Where an agent's memories are listed. */
export const memoriesOf = (agent: string): Next => ({ say: gatewayWording().lookIn.memories, run: commandOf("memory.list", [agent]) });

/** An error's words, whatever its tag. */
export const reasonOf = (e: ApiError): string =>
  "reason" in e && typeof e.reason === "string" ? e.reason : "what" in e && typeof e.what === "string" ? e.what : e._tag;
