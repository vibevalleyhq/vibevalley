import { Effect, Schema } from "effect";

import { ToolFailed } from "@vibevalley/agent/core/errors";
import { effectTool } from "@vibevalley/agent/core/tool";
import type { JsonSchema } from "@vibevalley/ai/tools";
import { ApiError as ApiErrorSchema } from "@vibevalley/protocol/api";

import type { Actor } from "@/base/actor.ts";
import { messageOf, reasonOf } from "@/errors.ts";
import { maxTasks } from "@/task/graph.ts";

import { answers, descriptions, sessionDescriptions } from "./prompts.ts";
import { type Op, parameters, schemas, sessionParameters, sessionSchemas, toolName } from "./schemas.ts";

export type Orchestrator<K extends keyof typeof parameters> = (typeof parameters)[K]["Type"];

export type SessionInput<K extends keyof typeof sessionParameters> = (typeof sessionParameters)[K]["Type"];

export interface Caller {
  /** The profile: an orchestrator's own id for an orchestrator. */
  readonly agent: string;
  /** The session working as agent, and the project it works in; both empty for the orchestrator. */
  readonly session: string;
  readonly project: string;
  /** The channel the orchestrator is answering. A session's default is its own issue thread, which the channel service knows. */
  readonly here: string;
  /** The profile the owner picked for this input, if any: dispatch prefers it. */
  readonly picked: string;
  /** Who calls, and on whose word: the services judge what it may do by it. */
  readonly actor: Actor;
}

export type Who = () => Caller;

export class ToolRefusal extends Schema.TaggedError<ToolRefusal, { readonly brand: unique symbol }>()("ToolRefusal", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const refuse = (message: string) => Effect.fail(new ToolRefusal({ message }));

const toFailed = (e: unknown): ToolFailed => new ToolFailed({ message: Schema.is(ApiErrorSchema)(e) ? reasonOf(e) : messageOf(e), cause: e });

export const said = (e: unknown) => toFailed(e).message;

export const callerOf = (who: Who) => Effect.try({ try: who, catch: (e) => new ToolRefusal({ message: said(e), cause: e }) });

/** An answer, or "没成：" and why. */
export const answered = <E>(e: Effect.Effect<string, E>) => Effect.catch(e, (err) => Effect.succeed(answers.failed(said(err))));

// Who reads and speaks in a channel: a session as itself, the orchestrator as the orchestrator.
export const participant = (c: Caller) => c.session || c.agent;

// A tool's arguments are read by its Schema before it runs; the model's JSON Schema is made from the same one.
// Named by its endpoint (toolName): the name is never written a second time.
const toolOf =
  <All extends { readonly [op: string]: Schema.Codec<unknown, unknown> }>(
    all: All,
    shown: Record<keyof All & string, JsonSchema>,
    words: Record<keyof All & string, string>,
  ) =>
  <K extends keyof All & Op, E>(op: K, body: (p: All[K]["Type"]) => Effect.Effect<string, E>) => {
    const read: (args: unknown) => Effect.Effect<All[K]["Type"], Schema.SchemaError> = Schema.decodeUnknownEffect<All[K]>(all[op]);
    return effectTool<unknown>({
      name: toolName(op),
      description: words[op],
      parameters: shown[op],
      run: (args) => Effect.mapError(Effect.flatMap(read(args), body), toFailed),
    });
  };

export const tool = toolOf(parameters, schemas, descriptions);
export const sessionSchemaTool = toolOf(sessionParameters, sessionSchemas, {
  ...sessionDescriptions,
  "issue.split": sessionDescriptions["issue.split"](maxTasks),
});
