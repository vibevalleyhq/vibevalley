// A brain on pi-ai's faux provider, for tests: no model is reached. Every request's transcript is kept, as the model saw it.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type FauxResponseStep,
  fauxProvider,
  type Message,
  type SimpleStreamOptions,
  type Tool,
  type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain, type BrainEvent, type BrainOptions } from "./agent.ts";
import { codingTools } from "./coding.ts";
import type { LLM } from "./config.ts";
import { messageText, userMessage } from "./messages.ts";

export interface Request {
  readonly messages: Message[];
  readonly options: SimpleStreamOptions | undefined;
}

export const systemPrompt = (r: { messages: readonly Message[] }) => {
  const head = r.messages[0];
  return head?.role === "system" ? (typeof head.content === "string" ? head.content : head.content.map((c) => (c.type === "text" ? c.text : "")).join("")) : "";
};
export const toolsOf = (r: { messages: readonly Message[] }): Tool[] => {
  const head = r.messages[0];
  return head?.role === "system" ? (head.toolsAdded ?? []) : [];
};
export const lastUser = (r: { messages: readonly Message[] }) => {
  const m = r.messages.findLast((x) => x.role === "user");
  return m ? messageText(m) : "";
};
export const results = (r: { messages: readonly Message[] }) =>
  r.messages.flatMap((m) => (m.role === "toolResult" ? [{ failed: m.isError, text: messageText(m) }] : []));
export const answered = (r: { messages: readonly Message[] }) => r.messages.at(-1)?.role === "toolResult";

export function fauxLLM(options: RegisterFauxProviderOptions = {}) {
  const faux = fauxProvider(options);
  const requests: Request[] = [];
  const stream: StreamFn = (model, context, o) => {
    requests.push({ messages: structuredClone(context.messages), options: o });
    return faux.provider.streamSimple(model, context, o);
  };
  const llm: LLM = { model: faux.getModel(), stream };
  return {
    faux,
    llm,
    requests,
    append: (steps: FauxResponseStep[]) => faux.appendResponses(steps),
  };
}

export function tempHome(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vibevalley-agent-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function until(f: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!f()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

export interface Rig {
  readonly agent: Brain;
  readonly events: BrainEvent[];
  readonly requests: Request[];
  readonly faux: ReturnType<typeof fauxLLM>["faux"];
  readonly has: (type: BrainEvent["type"]) => boolean;
  readonly ask: (text: string) => Promise<string>;
}

export async function withAgent(
  dir: string,
  steps: FauxResponseStep[],
  body: (r: Rig) => Promise<void>,
  extra: Partial<BrainOptions> = {},
  fauxOptions: RegisterFauxProviderOptions = {},
) {
  const { faux, llm, requests } = fauxLLM(fauxOptions);
  faux.appendResponses(steps);
  const agent = await Brain.start({
    name: "test",
    instructions: "你是测试用的助手。",
    llm,
    home: dir,
    cwd: dir,
    noSkills: true,
    tools: codingTools({ cwd: dir }),
    ...extra,
  });
  const events: BrainEvent[] = [];
  agent.subscribe((e) => events.push(e));
  try {
    await body({
      agent,
      events,
      requests,
      faux,
      has: (type) => events.some((e) => e.type === type),
      ask: (text) => agent.ask(userMessage(text)),
    });
  } finally {
    await agent.close();
  }
}
