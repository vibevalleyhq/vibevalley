// The tagged errors the API answers with (@vibevalley/protocol/api), made where a service refuses.

import { t } from "@vibevalley/i18n";

import { Data, Effect, Predicate } from "effect";
import { type ApiError, commandOf, type Next } from "@vibevalley/protocol/api";

export type { ApiError, Next };

export const refused = (reason: string, next?: readonly Next[]): ApiError => ({ _tag: "Refused", reason, ...(next && next.length > 0 ? { next } : {}) });

/** What a hint to list the ones that are names (server.lookIn in the catalog). */
type LookIn =
  | "issue"
  | "session"
  | "project"
  | "runtime"
  | "agent"
  | "skill"
  | "template"
  | "cron"
  | "device"
  | "archive"
  | "channel"
  | "graph"
  | "memories"
  | "artifact";

/** Something asked for by id or name is not there. next is required: where to look for the ones that are (lookIn). */
export const missing = (what: string, next: readonly Next[]): ApiError => ({ _tag: "Missing", what, ...(next.length > 0 ? { next } : {}) });

/** Where to find the ones that are there, as the command that lists them; cli.test.ts runs each one's help, so a command
 * renamed away breaks the test, not the hint. */
// say is read when the error is made, in the locale of the moment.
const listed = (key: LookIn, run: readonly string[]): Next => ({
  get say() {
    return t(`server.lookIn.${key}`);
  },
  run: [...run],
});

export const lookIn = {
  issue: listed("issue", commandOf("issue.list")),
  session: listed("session", commandOf("session.list")),
  project: listed("project", commandOf("project.list")),
  runtime: listed("runtime", commandOf("runtime.list")),
  agent: listed("agent", commandOf("agent.list")),
  skill: listed("skill", commandOf("skill.list")),
  template: listed("template", commandOf("agent.template.list")),
  cron: listed("cron", commandOf("cron.list")),
  device: listed("device", commandOf("lan.get")),
  archive: listed("archive", commandOf("orchestrator.archive.list")),
  channel: listed("channel", commandOf("channel.list")),
  graph: listed("graph", commandOf("graph.list")),
  artifact: listed("artifact", commandOf("artifact.list")),
} satisfies Record<string, Next>;

/** Where an agent's memories are listed. */
export const memoriesOf = (agent: string): Next => ({ say: t("server.lookIn.memories"), run: commandOf("memory.list", [agent]) });

/** An error's words, whatever its tag. */
export const reasonOf = (e: ApiError): string =>
  "reason" in e && typeof e.reason === "string" ? e.reason : "what" in e && typeof e.what === "string" ? e.what : e._tag;

/** What a thrown or rejected value says: an Error's message, anything else as text. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A failed system call's code (ENOENT, EPERM…), or undefined for anything else. */
export const errnoOf = (e: unknown): string | undefined => (e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined);

/** A defect, never an expected failure: the farm's own records disagree with each other, or a caller broke a rule it is
 * held to. Died with, so it is a bug to fix, found by this name. */
export class Inconsistent extends Data.TaggedError("Inconsistent")<{ readonly message: string }> {}

/** A lookup's answer, or Missing (what was not found, and where to look) when it found none. */
export const orMissing =
  (what: string, look: readonly Next[]) =>
  <A, E, R>(found: Effect.Effect<A | undefined, E, R>): Effect.Effect<A, E | ApiError, R> =>
    Effect.filterOrFail(found, Predicate.isNotUndefined, () => missing(what, look));
