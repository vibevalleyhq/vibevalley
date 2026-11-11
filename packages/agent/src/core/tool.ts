import { Effect, Schema } from "effect";

import { type JsonSchema, parametersOf } from "@vibevalley/ai/tools";

import { type ToolFailed, toolFailed } from "./errors.ts";
import type { Tool } from "./loop.ts";
import { toolResult } from "./prompts.ts";

/** A tool result when the run was stopped while it worked, and the end of a tool the stop cut off. */
export const stopped = toolResult.stopped;

/** The model gets the head and the tail, and a note. */
const maxResultChars = 30_000;

function clip(text: string, limit = maxResultChars): string {
  const r = [...text];
  if (r.length <= limit) return text;
  const head = Math.trunc(limit * 0.7);
  const tail = Math.trunc(limit * 0.3);
  return r.slice(0, head).join("") + toolResult.clippedNote(r.length - limit) + r.slice(r.length - tail).join("");
}

interface ToolContext {
  readonly callId: string;
  /** Aborted when the run is stopped. */
  readonly signal: AbortSignal;
}

interface TextToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly run: (params: unknown, tc: ToolContext) => string | Promise<string>;
}

const answered = (text: string) => ({ content: [{ type: "text" as const, text: clip(text) }] });

/** run's thrown or rejected error is the failed result. */
const ranText = (run: (signal: AbortSignal) => string | Promise<string>) =>
  Effect.map(Effect.tryPromise({ try: (signal) => Promise.resolve(run(signal)), catch: toolFailed }), answered);

export const textTool = (spec: TextToolSpec): Tool => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters,
  execute: (params, call) => ranText((signal) => spec.run(params, { callId: call.id, signal })),
});

interface EffectToolSpec extends Omit<TextToolSpec, "run"> {
  /** A failure's message is the failed result the model reads. */
  readonly run: (params: unknown) => Effect.Effect<string, ToolFailed>;
}

export const effectTool = (spec: EffectToolSpec): Tool => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters,
  execute: (params) => Effect.map(spec.run(params), answered),
});

interface SchemaToolSpec<S extends Schema.Struct<Schema.Struct.Fields>> extends Omit<TextToolSpec, "parameters" | "run"> {
  readonly parameters: S;
  readonly run: (params: S["Type"], tc: ToolContext) => string | Promise<string>;
}

/** A tool whose parameters are a Schema. */
export function schemaTool<S extends Schema.Struct<Schema.Struct.Fields> & Schema.Codec<S["Type"]>>(spec: SchemaToolSpec<S>): Tool {
  const read = Schema.decodeUnknownEffect(spec.parameters);
  return {
    name: spec.name,
    description: spec.description,
    parameters: parametersOf(spec.parameters),
    execute: (params, call) => Effect.flatMap(Effect.mapError(read(params), toolFailed), (p) => ranText((signal) => spec.run(p, { callId: call.id, signal }))),
  };
}

interface SchemaEffectToolSpec<S extends Schema.Struct<Schema.Struct.Fields>> extends Omit<EffectToolSpec, "parameters" | "run"> {
  readonly parameters: S;
  readonly run: (params: S["Type"]) => Effect.Effect<string, ToolFailed>;
}

export function schemaEffectTool<S extends Schema.Struct<Schema.Struct.Fields> & Schema.Codec<S["Type"]>>(spec: SchemaEffectToolSpec<S>): Tool {
  const read = Schema.decodeUnknownEffect(spec.parameters);
  return effectTool({
    ...spec,
    parameters: parametersOf(spec.parameters),
    run: (p) => Effect.flatMap(Effect.mapError(read(p), toolFailed), spec.run),
  });
}
