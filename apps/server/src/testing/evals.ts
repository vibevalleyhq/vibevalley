import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";

import { ToolFailed } from "@vibevalley/agent/core/errors";
import type { Tool } from "@vibevalley/agent/core/tool";
import { selfTools } from "@vibevalley/agent/self";
import { abortable } from "@vibevalley/async";
import { defaultOrchestrator } from "@vibevalley/protocol";

import { orchestrator } from "#/base/actor.ts";
import { type Op, schemas, toolName } from "#/gateway/tool/schemas.ts";
import { type ModelAccess, messageText, type ModelMessage } from "#/modules/agent/durable.ts";
import { orchestratorHost, orchestratorInput } from "#/modules/orchestrator/orchestrator.ts";
import { channelLine, noResult, situationWords } from "#/modules/orchestrator/prompts.ts";
import { type CaseInput, turnOf } from "#/modules/session/host.ts";

import { starter, testConfig } from "./layers.ts";
import { type World, world } from "./world.ts";

/** A message of a case: one the model saw, or the hosted input that began the turn. */
export type CaseMessage = ModelMessage | CaseInput;

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
  readonly before: readonly CaseMessage[];
  readonly input: CaseMessage;
  /** An isolated synthetic farm, not a reconstruction of the historical farm in did. */
  readonly scenario?: { readonly repos: readonly string[] };
  readonly did: readonly CaseMessage[];
  /** Empty when saved. */
  readonly expect: readonly Expect[];
}

export const kinds = ["called", "notCalled", "silent", "says", "saysNot", "brief"] as const;

/** The orchestrator's tools by name, as its brain has them: the farm's and its own (no skills, subagents or crons). */
export const orchestratorToolNames = () => [
  ...(Object.keys(schemas) as Op[]).map(toolName),
  ...selfTools({ home: "", skills: async () => [], memory: true, now: () => 0 }).map((t) => t.name),
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

const assistants = (turn: readonly CaseMessage[]) => turn.filter((m): m is AssistantMessage => m.role === "assistant");
const callsOf = (turn: readonly CaseMessage[]) => assistants(turn).flatMap((a) => a.content.filter((c): c is ToolCall => c.type === "toolCall"));
/** What it said in the turn, each message's words on a line. */
const wordsOf = (turn: readonly CaseMessage[]) =>
  assistants(turn)
    .map((a) => messageText(a).trim())
    .filter(Boolean)
    .join("\n");

/** A turn as a failed sample shows it: what it said, each call and each result. */
export function transcript(turn: readonly CaseMessage[]): string {
  const out: string[] = [];
  for (const m of turn)
    switch (m.role) {
      case "custom":
      case "user":
        out.push("## input\n" + (m.role === "custom" ? m.content : messageText(m)));
        break;
      case "assistant":
        for (const c of m.content) {
          if (c.type === "text" && c.text.trim() !== "") out.push("## said\n" + c.text);
          if (c.type === "toolCall") out.push("## called " + c.name + "\n" + JSON.stringify(c.arguments));
        }
        break;
      case "toolResult":
        out.push("## " + m.toolName + (m.isError ? " failed" : " answered") + "\n" + messageText(m));
        break;
    }
  return out.join("\n\n");
}

/** The expectations the turn does not meet, each as it is written; none when it passes. */
export function check(expect: readonly Expect[], turn: readonly CaseMessage[]): string[] {
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

export const isInput = (m: CaseMessage): m is CaseInput => m.role === "custom" && m.customType === orchestratorInput;

export const committed = join(import.meta.dirname, "..", "modules", "orchestrator", "testdata", "evals");

const sortedKeys = (_: string, v: unknown): unknown =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => (a < b ? -1 : 1))) : v;
/** Arguments as one string whatever order their keys came in; a model's arguments are parsed JSON, so they always write. */
const argsKey = (args: unknown): string => {
  try {
    return JSON.stringify(args, sortedKeys) ?? "";
  } catch {
    // A circular or unwritable value matches no recorded call; model arguments never are.
    return "";
  }
};

/** Every farm tool answers a call with what the case recorded for the same call (the same tool and arguments), each once, and nothing for another. */
export function stubbed(tools: readonly Tool[], did: readonly CaseMessage[]): Tool[] {
  const calls = new Map<string, string>();
  for (const m of did) if (m.role === "assistant") for (const c of m.content) if (c.type === "toolCall") calls.set(c.id, c.name + " " + argsKey(c.arguments));
  const recorded = new Map<string, Extract<CaseMessage, { role: "toolResult" }>[]>();
  for (const m of did) {
    if (m.role !== "toolResult") continue;
    const key = calls.get(m.toolCallId);
    if (key) recorded.set(key, [...(recorded.get(key) ?? []), m]);
  }
  return tools.map((t) => ({
    ...t,
    execute: async (args: unknown) => {
      const next = recorded.get(t.name + " " + argsKey(args))?.shift();
      if (!next) return { content: [{ type: "text" as const, text: noResult }] };
      if (next.isError) throw new ToolFailed(next.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
      return { content: next.content };
    },
  }));
}

const evalRuntime = scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("Synthetic eval worker received the task.") });

/** The farm a case replays on; models is the DeepSeek its harness asks, the scripted one a test seats when absent. */
export function replayWorld(c: EvalCase, models?: ModelAccess) {
  const config = testConfig();
  return world({
    ...(c.scenario
      ? {
          config: { ...config, agent: { ...config.agent, starters: ["lab"] } },
          repos: c.scenario.repos,
          runtimes: [evalRuntime],
        }
      : { config }),
    ...(models ? { models } : {}),
  });
}

/** The orchestrator's tools on the farm, and its input's words: stubbed with what the case recorded, or, for a scenario, live
 * on the farm with the situation it would have been told. */
export async function replaySetup(farm: World, c: EvalCase) {
  const chat = farm.channel;
  const here = chat.defaultChannel();
  const tools = farm.tool.orchestrator(() => ({
    agent: defaultOrchestrator,
    session: "",
    repo: "",
    here,
    picked: "",
    envelope: "",
    actor: orchestrator(true),
  }));
  if (!isInput(c.input)) throw new Error("A case begins with an orchestrator input");
  if (!c.scenario) return { tools: stubbed(tools, c.did), input: c.input.content };
  const profile = await farm.agent.save({ ...starter("lab"), enabled: true, effort: "" });
  const repos = farm.repo;
  const folders = await repos.list();
  const channels = await chat.channels();
  const address = await chat.addressOf(here);
  const situation = situationWords.whole(
    repos.root,
    situationWords.repos(folders.map((repo) => repo.name)),
    "",
    situationWords.agent(profile.name, profile.id, profile.runtime, ""),
    channels.map((channel) => channelLine(channel) + "\n" + situationWords.noHelpers).join("\n"),
    address.target,
    "zh",
  );
  return { tools, input: situation + "\n\n" + c.input.content };
}

const context = BACKGROUND_CONTEXT;

/** The assistant's turn on the farm's harness, as the farm runs it: the host the orchestrator makes (its prompt, its
 * own tools, the model asked through the farm's DeepSeek), with tools for the farm's and memory and before as the
 * conversation's past; what the model did after input, and the tokens it took. Throws why the turn failed. */
export async function orchestratorTurn(
  farm: World,
  o: { readonly model: string; readonly tools: readonly Tool[]; readonly memory: string; readonly before: readonly CaseMessage[]; readonly input: string },
  signal?: AbortSignal,
): Promise<{ readonly turn: ModelMessage[]; readonly tokens: number }> {
  const id = defaultOrchestrator;
  const durable = farm.agent.durable;
  if (o.memory) await farm.memory.forAgent(id, id).rewrite(o.memory);
  const past = o.before.filter((m): m is ModelMessage => m.role !== "custom");
  if (past.length > 0) {
    const kept = await durable.conversation(id, {});
    await kept.commit(async (tx) => {
      for (const m of past) await tx.appendEntry(kept.id, { kind: "vibevalley.replayed", model: [m] });
    }, context);
  }
  const here = farm.channel.defaultChannel();
  await using host = await farm.session.host({
    ...orchestratorHost(farm.config, id, farm.agent.agent(id)),
    model: () => o.model,
    tools: () => [...o.tools],
    first: { channel: here },
    quiet: () => true,
    say: async () => {},
    channel: (r) => r.channel,
    fresh: () => {},
    restored: (r) => ({ by: { kind: "comment", channel: r.channel } }),
    toolStart: farm.tool.start,
  });
  await host.submit(async () => ({ text: o.input }), { route: { channel: here }, run: { by: { kind: "comment", channel: here } } }, true);
  const conversation = await durable.existing(id);
  if (!conversation) throw new Error("the assistant has no conversation");
  // The run started is the one the input placed: wait for it to end.
  for (;;) {
    await conversation.waitForIdle(context);
    if (!(await durable.busy(id))) break;
    await abortable(new Promise((resolve) => setImmediate(resolve)), signal);
  }
  const entries = (await conversation.entries({ order: "ascending" }, 100_000, undefined, context)).items;
  const at = entries.findLastIndex((e) => e.kind === orchestratorInput);
  const turn = turnOf(entries.slice(at + 1), orchestratorInput);
  let tokens = 0;
  for (const m of turn) {
    if (m.role !== "assistant") continue;
    tokens += m.usage.totalTokens;
    if (m.stopReason === "error") throw new Error("the model: " + (m.errorMessage ?? ""));
  }
  return { turn, tokens };
}
