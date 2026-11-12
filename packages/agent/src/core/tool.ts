import type { z } from "zod";

import { toolFailed } from "./errors.ts";
import { toolResult } from "./prompts.ts";
import { type JsonSchema, parametersOf } from "./schema.ts";

export interface ToolResult {
  readonly content: readonly (
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  )[];
  readonly isError?: boolean;
  /** Ends the run after the round when every tool call in it sets `terminate: true`. */
  readonly terminate?: boolean;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  /** A ToolFailed it throws is the failed result the model reads. The signal aborts when the run is stopped. */
  readonly execute: (args: unknown, call: { readonly id: string }, signal?: AbortSignal) => Promise<ToolResult>;
}

/** The model gets the head and the tail, and a note. */
const maxResultChars = 30_000;

function clip(text: string, limit = maxResultChars): string {
  const r = [...text];
  if (r.length <= limit) return text;
  const head = Math.trunc(limit * 0.7);
  const tail = Math.trunc(limit * 0.3);
  return r.slice(0, head).join("") + toolResult.clippedNote(r.length - limit) + r.slice(r.length - tail).join("");
}

const answered = (text: string): ToolResult => ({ content: [{ type: "text", text: clip(text) }] });

interface RunToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  /** Throws a ToolFailed: its message is the failed result the model reads. The signal aborts when the run stops. */
  readonly run: (params: unknown, signal?: AbortSignal) => Promise<string>;
}

/** A tool whose work throws its ToolFailed itself. */
export const runTool = (spec: RunToolSpec): Tool => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters,
  execute: async (params, _call, signal) => answered(await spec.run(params, signal)),
});

interface SchemaToolSpec<S extends z.ZodObject> extends Omit<RunToolSpec, "parameters" | "run"> {
  readonly parameters: S;
  readonly run: (params: z.output<S>, signal?: AbortSignal) => Promise<string>;
}

/** The arguments are read by the Schema first; ones it refuses are a failed result. */
export function schemaTool<S extends z.ZodObject>(spec: SchemaToolSpec<S>): Tool {
  return runTool({
    ...spec,
    parameters: parametersOf(spec.parameters),
    run: (p, signal) => {
      const read = spec.parameters.safeParse(p);
      if (!read.success) return Promise.reject(toolFailed(read.error));
      return spec.run(read.data, signal);
    },
  });
}
