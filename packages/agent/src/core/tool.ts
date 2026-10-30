// A tool that fails throws (or fails, as an Effect): the model reads the error's message as a failed result.

import { type ToolFailed, toolFailed } from "./errors.ts";
import { Effect, Schema } from "effect";
import { type JsonSchema, parametersOf } from "@vibevalley/ai/tools";
import type { Tool } from "./loop.ts";
import { toolResult } from "./prompts.ts";

/** A tool result when the run was stopped while it worked, and the end of a tool the stop cut off. */
export const stopped = toolResult.stopped;

/** The model gets the head and the tail, and a note. */
export const maxResultChars = 30_000;

export function clip(text: string, limit = maxResultChars): string {
  const r = [...text];
  if (r.length <= limit) return text;
  const head = Math.trunc(limit * 0.7);
  const tail = Math.trunc(limit * 0.3);
  return r.slice(0, head).join("") + toolResult.clippedNote(r.length - limit) + r.slice(r.length - tail).join("");
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

export const textTool = <P>(spec: TextToolSpec<P>): Tool => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters,
  execute: (params, call) =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the loop checked the arguments against parameters before execute
    Effect.map(Effect.tryPromise({ try: async (signal) => spec.run(params as P, { callId: call.id, signal }), catch: toolFailed }), answered),
});

export interface EffectToolSpec<P> extends Omit<TextToolSpec<P>, "run"> {
  /** A failure's message is the failed result the model reads. */
  readonly run: (params: P) => Effect.Effect<string, ToolFailed>;
}

export const effectTool = <P>(spec: EffectToolSpec<P>): Tool => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the loop checked the arguments against parameters before execute
  execute: (params) => Effect.map(spec.run(params as P), answered),
});

export interface SchemaToolSpec<S extends Schema.Struct<Schema.Struct.Fields>> extends Omit<TextToolSpec<S["Type"]>, "parameters"> {
  readonly parameters: S;
}

/** A tool whose parameters are a Schema: the model is shown parametersOf, and the arguments are read by the Schema
 * before run (a refusal is the failed result the model reads). */
export function schemaTool<S extends Schema.Struct<Schema.Struct.Fields>>(spec: SchemaToolSpec<S>): Tool {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a tool's Struct decodes with no services
  const read = Schema.decodeUnknownSync(spec.parameters as unknown as Schema.Codec<S["Type"]>);
  return textTool<unknown>({ ...spec, parameters: parametersOf(spec.parameters), run: (p, tc) => spec.run(read(p), tc) });
}

export interface SchemaEffectToolSpec<S extends Schema.Struct<Schema.Struct.Fields>> extends Omit<EffectToolSpec<S["Type"]>, "parameters"> {
  readonly parameters: S;
}

export function schemaEffectTool<S extends Schema.Struct<Schema.Struct.Fields>>(spec: SchemaEffectToolSpec<S>): Tool {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a tool's Struct decodes with no services
  const read = Schema.decodeUnknownSync(spec.parameters as unknown as Schema.Codec<S["Type"]>);
  return effectTool<unknown>({
    ...spec,
    parameters: parametersOf(spec.parameters),
    run: (p) => Effect.flatMap(Effect.try({ try: () => read(p), catch: toolFailed }), spec.run),
  });
}
