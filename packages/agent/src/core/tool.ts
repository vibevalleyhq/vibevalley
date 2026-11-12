import type { z } from "zod";

import { type JsonSchema, parametersOf } from "@vibevalley/ai/tools";

import { toolFailed } from "./errors.ts";
import type { Tool, ToolResult } from "./loop.ts";
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

const answered = (text: string): ToolResult => ({ content: [{ type: "text", text: clip(text) }] });

/** A signal for a call made without one: never aborted. */
const never = () => new AbortController().signal;

/** run's thrown or rejected error is the failed result. */
export const textTool = (spec: TextToolSpec): Tool => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters,
  execute: async (params, call, signal) => {
    try {
      return answered(await spec.run(params, { callId: call.id, signal: signal ?? never() }));
    } catch (e) {
      throw toolFailed(e);
    }
  },
});

interface EffectToolSpec extends Omit<TextToolSpec, "run"> {
  /** Throws a ToolFailed: its message is the failed result the model reads. The signal aborts when the run stops. */
  readonly run: (params: unknown, signal?: AbortSignal) => Promise<string>;
}

/** A tool whose work throws its ToolFailed itself (the name is the one the hosts know it by). */
export const effectTool = (spec: EffectToolSpec): Tool => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters,
  execute: async (params, _call, signal) => answered(await spec.run(params, signal)),
});

interface SchemaEffectToolSpec<S extends z.ZodObject> extends Omit<EffectToolSpec, "parameters" | "run"> {
  readonly parameters: S;
  readonly run: (params: z.output<S>, signal?: AbortSignal) => Promise<string>;
}

/** The arguments are read by the Schema first; ones it refuses are a failed result. */
export function schemaEffectTool<S extends z.ZodObject>(spec: SchemaEffectToolSpec<S>): Tool {
  return effectTool({
    ...spec,
    parameters: parametersOf(spec.parameters),
    run: (p, signal) => {
      const read = spec.parameters.safeParse(p);
      if (!read.success) return Promise.reject(toolFailed(read.error));
      return spec.run(read.data, signal);
    },
  });
}
