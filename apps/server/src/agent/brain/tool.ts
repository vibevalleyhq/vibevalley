// Tools that answer in words. A tool that fails throws; the model reads the error's message as a failed result.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Effect, Schema } from "effect";
import { type JsonSchema, parametersOf } from "../../ai/tools.ts";

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
  readonly signal: AbortSignal;
}

export interface TextToolSpec<P> {
  readonly name: string;
  /** The name when absent. */
  readonly label?: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly run: (params: P, tc: ToolContext) => string | Promise<string>;
}

const never = new AbortController().signal;

export function textTool<P>(spec: TextToolSpec<P>): AgentTool {
  return {
    name: spec.name,
    label: spec.label ?? spec.name,
    description: spec.description,
    parameters: spec.parameters,
    execute: async (callId, params, signal) => {
      const s = signal ?? never;
      if (s.aborted) throw new Error(stopped);
      let text: string;
      try {
        text = await spec.run(params as P, { callId, signal: s });
      } catch (e) {
        // A run that follows the signal fails when it is stopped: that is the stop, not the tool's failure.
        throw s.aborted ? new Error(stopped) : e;
      }
      if (s.aborted) throw new Error(stopped);
      return { content: [{ type: "text", text: clip(text) }], details: undefined };
    },
  };
}

export interface EffectToolSpec<P> extends Omit<TextToolSpec<P>, "run"> {
  /** A failure's message is the failed result the model reads. */
  readonly run: (params: P) => Effect.Effect<string, Error>;
}

/** Runs an Effect to its answer on fibers someone owns; the signal interrupts it. */
export type Runner = (effect: Effect.Effect<string, Error>, options: { readonly signal: AbortSignal }) => Promise<string>;

export const effectTool = <P>(spec: EffectToolSpec<P>, runner: Runner): AgentTool =>
  textTool<P>({ ...spec, run: (params, tc) => runner(spec.run(params), { signal: tc.signal }) });

export interface SchemaToolSpec<S extends Schema.Struct<Schema.Struct.Fields>> extends Omit<TextToolSpec<S["Type"]>, "parameters"> {
  readonly parameters: S;
}

/** A tool whose parameters are a Schema: the model is shown parametersOf, and the arguments are read by the Schema
 * before run (a refusal is the failed result the model reads). */
export function schemaTool<S extends Schema.Struct<Schema.Struct.Fields>>(spec: SchemaToolSpec<S>): AgentTool {
  const read = Schema.decodeUnknownSync(spec.parameters as unknown as Schema.Codec<S["Type"]>);
  return textTool<unknown>({ ...spec, parameters: parametersOf(spec.parameters), run: (p, tc) => spec.run(read(p), tc) });
}
