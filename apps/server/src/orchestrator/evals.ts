// The orchestrator's evals (orchestrator.markWrong saves them): a turn the owner marked wrong, with what the model saw before it, and
// the checks that catch the error, written by whoever fixes it. evals.test.ts holds the committed cases (testdata/evals) to
// their checks; evals.live.test.ts replays them on the real model.

import type { AssistantMessage, ToolCall } from "../ai/messages.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BrainMessage, messageText } from "../agent/brain/messages.ts";
import { selfTools } from "../agent/brain/self.ts";
import { type Op, schemas, toolName } from "../tool/schemas.ts";

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
  readonly created: number;
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

/** The orchestrator's tools by name, as its brain has them: the farm's and its own (no skills, subagents or recurrences). */
export const orchestratorToolNames = () => [
  ...(Object.keys(schemas) as Op[]).map(toolName),
  ...selfTools({ home: "", skills: () => [], memory: true, now: () => 0 }).map((t) => t.name),
];

/** "" when it is whole: the fields its kind reads are there. */
export function problemOf(e: Expect): string {
  switch (e.kind) {
    case "called":
    case "notCalled":
      return e.tool ? "" : e.kind + " without a tool";
    case "says":
    case "saysNot":
      return e.contains ? "" : e.kind + " without contains";
    case "silent":
      return "";
    default:
      return `unknown kind ${JSON.stringify(e.kind)}`;
  }
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
      const json = JSON.stringify(c.arguments ?? {});
      return c.name === tool && json.includes(args) && (lacks === undefined || !json.includes(lacks));
    });
  const missed: string[] = [];
  for (const e of expect) {
    const problem = problemOf(e);
    if (problem) {
      missed.push(problem);
      continue;
    }
    const ok =
      e.kind === "called"
        ? called(e.tool!, e.argContains, e.argLacks)
        : e.kind === "notCalled"
          ? !called(e.tool!)
          : e.kind === "silent"
            ? words === ""
            : e.kind === "says"
              ? words.includes(e.contains!)
              : !words.includes(e.contains!);
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
  return names.sort().map((n) => ({ file: join(dir, n), case: JSON.parse(readFileSync(join(dir, n), "utf8")) as EvalCase }));
}

export const isInput = (m: BrainMessage) => m.role === "custom" && (m as { customType?: string }).customType === "orchestratorInput";

export const committed = join(import.meta.dirname, "testdata", "evals");
