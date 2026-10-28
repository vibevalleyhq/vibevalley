import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@vibevalley/ai/messages";
import { type Reply, type Request, scriptedLlm, type Step, testModel } from "@vibevalley/ai/testing";
import { type BrainEvent, type BrainHandle, type BrainOptions, type BrainOwner, openBrain, standaloneOwner } from "./brain.ts";
import { codingTools } from "./coding.ts";
import type { ModelClient } from "@vibevalley/ai/client";
import { messageText, userMessage } from "./messages.ts";

export type { Reply, Request, Step };

export const systemPrompt = (r: Request) => r.system;
export const toolsOf = (r: Request) => r.tools;
export const lastUser = (r: { messages: readonly Message[] }) => {
  const m = r.messages.findLast((x) => x.role === "user");
  return m ? messageText(m) : "";
};
export const results = (r: { messages: readonly Message[] }) =>
  r.messages.flatMap((m) => (m.role === "toolResult" ? [{ failed: m.isError, text: messageText(m) }] : []));
export const answered = (r: { messages: readonly Message[] }) => r.messages.at(-1)?.role === "toolResult";

export function scriptedLLM(steps: readonly Step[] = []) {
  const script = Effect.runSync(scriptedLlm(steps));
  const llm: ModelClient = { model: testModel, service: script.llm, apiKey: () => "k" };
  return {
    llm,
    requests: script.requests,
    append: script.append,
    pending: () => Effect.runSync(script.pending),
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
  readonly agent: BrainHandle;
  readonly events: BrainEvent[];
  readonly requests: Request[];
  readonly script: Pick<ReturnType<typeof scriptedLLM>, "append" | "pending">;
  readonly has: (type: BrainEvent["type"]) => boolean;
  readonly ask: (text: string) => Promise<string>;
}

/** owner: a test on its TestClock gives one that runs on the test's fibers. */
export async function withAgent(
  dir: string,
  steps: readonly Step[],
  body: (r: Rig) => Promise<void>,
  extra: Partial<BrainOptions> = {},
  owner: BrainOwner = standaloneOwner(),
) {
  const { llm, requests, append, pending } = scriptedLLM(steps);
  const agent = await openBrain(owner, {
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
      script: { append, pending },
      has: (type) => events.some((e) => e.type === type),
      ask: (text) => agent.ask(userMessage(text, Date.now())),
    });
  } finally {
    await agent.close();
  }
}
