// The orchestrator's evals (orchestrator.markWrong saves them): a turn the owner marked wrong, with what the model saw before it, and
// the checks that catch the error, written by whoever fixes it. evals.test.ts holds the committed cases (testdata/evals) to
// their checks; evals.live.test.ts replays them on the real model.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Effect, Predicate } from "effect";

import { ToolFailed } from "@vibevalley/agent/core/errors";
import type { Tool } from "@vibevalley/agent/core/loop";
import { type BrainMessage, messageText } from "@vibevalley/agent/messages";
import { selfTools } from "@vibevalley/agent/self";
import type { AssistantMessage, ToolCall } from "@vibevalley/ai/messages";

import { type Op, schemas, toolName } from "@/tool/schemas.ts";

import { noResult } from "./prompts.ts";

/** One check on a turn, a closed set by kind: called (tool, with argContains in its arguments' JSON and argLacks not in
 * it, each when given), notCalled (tool), silent (no words said), says (contains in the words), saysNot (contains not in
 * them). */
export interface Expect {
  readonly kind: string;
  readonly tool?: string;
  readonly argContains?: string;
  readonly argLacks?: string;
  readonly contains?: string;
}

/** As saved in evals/<id>.json under the orchestrator's home. before, input and did are lines of orchestrator.jsonl as written there:
 * what the model saw when the turn began (compactions applied), the input that began it, and the turn up to the next input. */
export interface EvalCase {
  readonly id: string;
  readonly createdAt: number;
  readonly model: string;
  readonly want: string;
  /** The whole MEMORY.md when the turn was marked, not necessarily as it was in the turn. */
  readonly memory: string;
  readonly tools: readonly string[];
  readonly before: readonly BrainMessage[];
  readonly input: BrainMessage;
  readonly did: readonly BrainMessage[];
  /** Empty when saved. */
  readonly expect: readonly Expect[];
}

export const kinds = ["called", "notCalled", "silent", "says", "saysNot"] as const;

/** The orchestrator's tools by name, as its brain has them: the farm's and its own (no skills, subagents or crons). */
export const orchestratorToolNames = () => [
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- schemas has one key per Op and no more
  ...(Object.keys(schemas) as Op[]).map(toolName),
  ...selfTools({ home: "", skills: () => [], memory: true, now: () => 0 }).map((t) => t.name),
];

type Checked =
  | { readonly kind: "called"; readonly tool: string; readonly argContains?: string | undefined; readonly argLacks?: string | undefined }
  | { readonly kind: "notCalled"; readonly tool: string }
  | { readonly kind: "silent" }
  | { readonly kind: "says" | "saysNot"; readonly contains: string };

/** The expectation as its kind reads it, or what is missing from it. */
function checkedOf(e: Expect): Checked | string {
  switch (e.kind) {
    case "called":
      return e.tool ? { kind: "called", tool: e.tool, argContains: e.argContains, argLacks: e.argLacks } : e.kind + " without a tool";
    case "notCalled":
      return e.tool ? { kind: "notCalled", tool: e.tool } : e.kind + " without a tool";
    case "says":
    case "saysNot":
      return e.contains ? { kind: e.kind, contains: e.contains } : e.kind + " without contains";
    case "silent":
      return { kind: "silent" };
    default:
      return `unknown kind ${JSON.stringify(e.kind)}`;
  }
}

/** "" when it is whole: the fields its kind reads are there. */
export function problemOf(e: Expect): string {
  const c = checkedOf(e);
  return typeof c === "string" ? c : "";
}

const assistants = (turn: readonly BrainMessage[]) => turn.filter((m): m is AssistantMessage => m.role === "assistant");
const callsOf = (turn: readonly BrainMessage[]) => assistants(turn).flatMap((a) => a.content.filter((c): c is ToolCall => c.type === "toolCall"));
/** What it said in the turn, each message's words on a line. */
const wordsOf = (turn: readonly BrainMessage[]) =>
  assistants(turn)
    .map((a) => messageText(a).trim())
    .filter(Boolean)
    .join("\n");

/** The expectations the turn does not meet, each as it is written; none when it passes. */
export function check(expect: readonly Expect[], turn: readonly BrainMessage[]): string[] {
  const calls = callsOf(turn);
  const words = wordsOf(turn);
  const called = (tool: string, args = "", lacks?: string) =>
    calls.some((c) => {
      const json = JSON.stringify(c.arguments);
      return c.name === tool && json.includes(args) && (lacks === undefined || !json.includes(lacks));
    });
  const missed: string[] = [];
  for (const e of expect) {
    const c = checkedOf(e);
    if (typeof c === "string") {
      missed.push(c);
      continue;
    }
    const ok =
      c.kind === "called"
        ? called(c.tool, c.argContains, c.argLacks)
        : c.kind === "notCalled"
          ? !called(c.tool)
          : c.kind === "silent"
            ? words === ""
            : c.kind === "says"
              ? words.includes(c.contains)
              : !words.includes(c.contains);
    if (!ok) missed.push(JSON.stringify(e));
  }
  return missed;
}

/** The cases in dir (*.json), by file name. */
export function casesIn(dir: string): { file: string; case: EvalCase }[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- cases are written by orchestrator.eval.create, in this file's EvalCase
  return names.toSorted().map((n) => ({ file: join(dir, n), case: JSON.parse(readFileSync(join(dir, n), "utf8")) as EvalCase }));
}

export const isInput = (m: BrainMessage) => m.role === "custom" && (m as { customType?: string }).customType === "orchestratorInput";

export const committed = join(import.meta.dirname, "testdata", "evals");

/** Arguments as one string whatever order their keys came in. */
const argsKey = (args: unknown): string =>
  JSON.stringify(args, (_, v: unknown) => (Predicate.isObject(v) ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => (a < b ? -1 : 1))) : v));

/** Every farm tool answers a call with what the case recorded for the same call (the same tool and arguments), each once,
 * and nothing for another: the recorded turn is the wrong one, and its answer to a call the model did not make again (a
 * start it was told not to make) would tell the model it did. None touches the farm; its own tools (memory, archive) work
 * on the replay's own home. */
export function stubbed(tools: readonly Tool[], did: readonly BrainMessage[]): Tool[] {
  const calls = new Map<string, string>();
  for (const m of did) if (m.role === "assistant") for (const c of m.content) if (c.type === "toolCall") calls.set(c.id, c.name + " " + argsKey(c.arguments));
  const recorded = new Map<string, Extract<BrainMessage, { role: "toolResult" }>[]>();
  for (const m of did) {
    if (m.role !== "toolResult") continue;
    const key = calls.get(m.toolCallId);
    if (key) recorded.set(key, [...(recorded.get(key) ?? []), m]);
  }
  return tools.map((t) => ({
    ...t,
    execute: (args: unknown) =>
      Effect.suspend(() => {
        const next = recorded.get(t.name + " " + argsKey(args))?.shift();
        if (!next) return Effect.succeed({ content: [{ type: "text" as const, text: noResult }] });
        if (next.isError) return Effect.fail(new ToolFailed({ message: next.content.map((c) => (c.type === "text" ? c.text : "")).join("") }));
        return Effect.succeed({ content: next.content });
      }),
  }));
}
