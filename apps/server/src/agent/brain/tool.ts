// A tool that fails throws (or fails, as an Effect): the model reads the error's message as a failed result.

import { Effect, Schema } from "effect";
import { type JsonSchema, parametersOf } from "../../ai/tools.ts";
import type { Tool } from "../loop/agent.ts";

/** A tool result when the run was stopped while it worked, and the end of a tool the stop cut off. */
export const stopped = "已停下";

/** The model gets the head and the tail, and a note. */
export const maxResultChars = 30_000;

export function clip(text: string, limit = maxResultChars): string {
  const r = [...text];
  if (r.length <= limit) return text;
  const head = Math.trunc(limit * 0.7);
  const tail = Math.trunc(limit * 0.3);
  return r.slice(0, head).join("") + `\n\n…（省略了 ${r.length - limit} 个字符）…\n\n` + r.slice(r.length - tail).join("");
}

export interface ToolContext {
  readonly callId: string;
  /** Aborted when the run is stopped. */
  readonly signal: AbortSignal;
}

export interface TextToolSpec<P> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly run: (params: P, tc: ToolContext) => string | Promise<string>;
}

const answered = (text: string) => ({ content: [{ type: "text" as const, text: clip(text) }] });

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

export const textTool = <P>(spec: TextToolSpec<P>): Tool => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters,
  execute: (params, call) =>
    Effect.map(Effect.tryPromise({ try: async (signal) => spec.run(params as P, { callId: call.id, signal }), catch: asError }), answered),
});

export interface EffectToolSpec<P> extends Omit<TextToolSpec<P>, "run"> {
  /** A failure's message is the failed result the model reads. */
  readonly run: (params: P) => Effect.Effect<string, Error>;
}

export const effectTool = <P>(spec: EffectToolSpec<P>): Tool => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters,
  execute: (params) => Effect.map(spec.run(params as P), answered),
});

export interface SchemaToolSpec<S extends Schema.Struct<Schema.Struct.Fields>> extends Omit<TextToolSpec<S["Type"]>, "parameters"> {
  readonly parameters: S;
}

/** A tool whose parameters are a Schema: the model is shown parametersOf, and the arguments are read by the Schema
 * before run (a refusal is the failed result the model reads). */
export function schemaTool<S extends Schema.Struct<Schema.Struct.Fields>>(spec: SchemaToolSpec<S>): Tool {
  const read = Schema.decodeUnknownSync(spec.parameters as unknown as Schema.Codec<S["Type"]>);
  return textTool<unknown>({ ...spec, parameters: parametersOf(spec.parameters), run: (p, tc) => spec.run(read(p), tc) });
}
