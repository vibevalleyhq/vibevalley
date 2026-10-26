// Tools that answer in words. A tool that fails throws; the model reads the error's message as a failed result.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Effect } from "effect";

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

export type Schema = Record<string, unknown>;

export function objectSchema(properties: Record<string, Schema> = {}, ...required: string[]): Schema {
  if (Object.keys(properties).length === 0) return { type: "object", properties: {} };
  return {
    type: "object",
    properties,
    additionalProperties: true,
    ...(required.length > 0 ? { required } : {}),
  };
}
export const stringSchema = (): Schema => ({ type: "string" });
export const integerSchema = (): Schema => ({ type: "integer" });
export const numberSchema = (): Schema => ({ type: "number" });
export const booleanSchema = (): Schema => ({ type: "boolean" });

export interface ToolContext {
  readonly callId: string;
  readonly signal: AbortSignal;
}

export interface TextToolSpec<P> {
  readonly name: string;
  /** The name when absent. */
  readonly label?: string;
  readonly description: string;
  readonly parameters: Schema;
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
