import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { Effect, Predicate } from "effect";

import { ToolFailed } from "@vibevalley/agent/core/errors";
import type { Tool } from "@vibevalley/agent/core/loop";
import { type BrainMessage, messageText } from "@vibevalley/agent/messages";
import { selfTools } from "@vibevalley/agent/self";
import type { AssistantMessage, ToolCall } from "@vibevalley/ai/messages";
import { defaultOrchestrator } from "@vibevalley/protocol";

import { Agent } from "#/agent/agent.ts";
import { orchestrator } from "#/base/actor.ts";
import { Channel } from "#/channel/channel.ts";
import { noResult, situationWords } from "#/orchestrator/prompts.ts";
import { Repo } from "#/repo/repo.ts";
import { channelLine } from "#/tool/prompts.ts";
import { type Op, schemas, toolName } from "#/tool/schemas.ts";
import { Tool as FarmTool } from "#/tool/tool.ts";

import { starter, testConfig } from "./layers.ts";
import { world } from "./world.ts";

/** One check on a turn, a closed set by kind. */
export interface Expect {
  readonly kind: string;
  readonly tool?: string;
  readonly argContains?: string;
  readonly argLacks?: string;
  readonly contains?: string;
  readonly maxChars?: number;
}

/** As saved in evals/<id>.json under the orchestrator's home. */
export interface EvalCase {
  readonly id: string;
  readonly createdAt: number;
  readonly model: string;
  readonly want: string;
  /** The memory snapshot when the turn was marked, not necessarily as it was in the turn. */
  readonly memory: string;
  readonly tools: readonly string[];
  readonly before: readonly BrainMessage[];
  readonly input: BrainMessage;
  /** An isolated synthetic farm, not a reconstruction of the historical farm in did. */
  readonly scenario?: { readonly repos: readonly string[] };
  readonly did: readonly BrainMessage[];
  /** Empty when saved. */
  readonly expect: readonly Expect[];
}

export const kinds = ["called", "notCalled", "silent", "says", "saysNot", "brief"] as const;

/** The orchestrator's tools by name, as its brain has them: the farm's and its own (no skills, subagents or crons). */
export const orchestratorToolNames = () => [
  ...(Object.keys(schemas) as Op[]).map(toolName),
  ...selfTools({ home: "", skills: () => Promise.resolve([]), memory: true, now: () => 0 }).map((t) => t.name),
];

type Checked =
  | { readonly kind: "called" | "notCalled"; readonly tool: string; readonly argContains?: string | undefined; readonly argLacks?: string | undefined }
  | { readonly kind: "silent" }
  | { readonly kind: "brief"; readonly maxChars: number }
  | { readonly kind: "says" | "saysNot"; readonly contains: string };

/** The expectation as its kind reads it, or what is missing from it. */
function checkedOf(e: Expect): Checked | string {
  switch (e.kind) {
    case "called":
    case "notCalled":
      return e.tool ? { kind: e.kind, tool: e.tool, argContains: e.argContains, argLacks: e.argLacks } : e.kind + " without a tool";
    case "brief":
      return e.maxChars !== undefined && Number.isInteger(e.maxChars) && e.maxChars > 0
        ? { kind: "brief", maxChars: e.maxChars }
        : "brief without a positive integer maxChars";
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
    let ok: boolean;
    switch (c.kind) {
      case "called":
        ok = called(c.tool, c.argContains, c.argLacks);
        break;
      case "notCalled":
        ok = !called(c.tool, c.argContains, c.argLacks);
        break;
      case "silent":
        ok = words === "";
        break;
      case "brief":
        ok = words.length > 0 && [...words].length <= c.maxChars && !/[\r\n]|[。！？.!?]\s*\S/u.test(words);
        break;
      case "says":
        ok = words.includes(c.contains);
        break;
      case "saysNot":
        ok = !words.includes(c.contains);
        break;
    }
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
  return names.toSorted().map((n) => ({ file: join(dir, n), case: JSON.parse(readFileSync(join(dir, n), "utf8")) as EvalCase }));
}

export const isInput = (m: BrainMessage) => m.role === "custom" && (m as { customType?: string }).customType === "orchestratorInput";

export const committed = join(import.meta.dirname, "..", "orchestrator", "testdata", "evals");

/** Arguments as one string whatever order their keys came in. */
const argsKey = (args: unknown): string =>
  JSON.stringify(args, (_, v: unknown) => (Predicate.isObject(v) ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => (a < b ? -1 : 1))) : v));

/** Every farm tool answers a call with what the case recorded for the same call (the same tool and arguments), each once, and nothing for another. */
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

const evalRuntime = scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("Synthetic eval worker received the task.") });

export function replayWorld(c: EvalCase) {
  const config = testConfig();
  return world(
    c.scenario
      ? {
          config: { ...config, agent: { ...config.agent, starters: ["lab"] } },
          repos: c.scenario.repos,
          runtimes: [evalRuntime],
        }
      : { config },
  );
}

export const replaySetup = Effect.fn("Eval.replaySetup")(function* (c: EvalCase) {
  const farm = yield* FarmTool;
  const chat = yield* Channel;
  const here = chat.defaultChannel();
  const tools = farm.orchestrator(() => ({ agent: defaultOrchestrator, session: "", repo: "", here, picked: "", envelope: "", actor: orchestrator(true) }));
  if (!c.scenario) return { tools: stubbed(tools, c.did), input: c.input };
  if (c.input.role !== "custom") throw new Error("A scenario needs an orchestrator input");
  const agents = yield* Agent;
  const profile = yield* agents.save({ ...starter("lab"), enabled: true, effort: "" });
  const repos = yield* Repo;
  const folders = yield* repos.list();
  const channels = yield* chat.channels();
  const address = yield* chat.addressOf(here);
  const situation = situationWords.whole(
    repos.root,
    situationWords.repos(folders.map((repo) => repo.name)),
    "",
    situationWords.agent(profile.name, profile.id, profile.runtime, ""),
    channels.map((channel) => channelLine(channel) + "\n" + situationWords.noHelpers).join("\n"),
    address.target,
    "zh",
  );
  return { tools, input: { ...c.input, content: situation + "\n\n" + messageText(c.input) } };
});
