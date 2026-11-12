import { rmSync } from "node:fs";

import type { ModelClient } from "@vibevalley/ai/client";
import type { Message } from "@vibevalley/ai/messages";
import { type Reply, type Request, scriptedLlm, type Step, testModel } from "@vibevalley/ai/testing";
import { type Clock, reasonOf } from "@vibevalley/async";
import { tempDir } from "@vibevalley/testkit/temp";
import { waitFor } from "@vibevalley/testkit/until";

import { messageText, userMessage } from "../base/messages.ts";
import { type Brain, type BrainEvent, type BrainOptions, makeBrain } from "../brain/brain.ts";
import { codingTools } from "../tools/coding.ts";

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
  const script = scriptedLlm(steps);
  const llm: ModelClient = { model: testModel, service: script.llm, apiKey: () => "k" };
  return {
    llm,
    requests: script.requests,
    append: script.append,
    pending: script.pending,
  };
}

export function tempHome(): { dir: string; done: () => void } {
  const dir = tempDir("vibevalley-agent-");
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A clock a test moves: it stands still until set or adjusted, and a sleep wakes once the time has come. */
export interface TestClock extends Clock {
  readonly setTime: (ms: number) => void;
  /** Moves the time on by ms, and lets what that wakes run. */
  readonly adjust: (ms: number) => Promise<void>;
}

export function testClock(start = 0): TestClock {
  let now = start;
  const sleepers = new Set<{ readonly at: number; readonly wake: () => void }>();
  const wakeDue = () => {
    for (const s of [...sleepers].toSorted((a, b) => a.at - b.at))
      if (s.at <= now) {
        sleepers.delete(s);
        s.wake();
      }
  };
  return {
    now: () => now,
    sleep: (ms, signal) => {
      if (signal?.aborted === true) return Promise.reject(reasonOf(signal));
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const sleeper = { at: now + Math.max(0, ms), wake: resolve };
      sleepers.add(sleeper);
      signal?.addEventListener(
        "abort",
        () => {
          sleepers.delete(sleeper);
          reject(reasonOf(signal));
        },
        { once: true },
      );
      wakeDue();
      return promise;
    },
    setTime: (ms) => {
      now = ms;
      wakeDue();
    },
    adjust: async (ms) => {
      now += ms;
      wakeDue();
      // What woke goes as far as it can before the test looks.
      for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

export interface Rig {
  readonly agent: Brain;
  readonly events: BrainEvent[];
  readonly requests: Request[];
  readonly script: Pick<ReturnType<typeof scriptedLLM>, "append" | "pending">;
  readonly clock: TestClock;
  readonly has: (type: BrainEvent["type"]) => boolean;
  readonly ask: (text: string) => Promise<string>;
}

/** What a test's brain is opened with: its home is dir, it runs dir's coding tools and has no skills. */
export const testBrain = (dir: string, llm: ModelClient, extra: Partial<BrainOptions> = {}): BrainOptions => ({
  name: "test",
  instructions: "你是测试用的助手。",
  llm,
  home: dir,
  cwd: dir,
  noSkills: true,
  tools: codingTools({ cwd: dir }),
  ...extra,
});

/** A brain on the test's clock (extra.clock, else one at 0 that stands still), closed once body is done, before what
 * follows it. */
export async function withAgent<A>(
  dir: string,
  steps: readonly Step[],
  body: (r: Rig) => Promise<A> | A,
  extra: Partial<BrainOptions> & { readonly clock?: TestClock } = {},
): Promise<A> {
  const { llm, requests, append, pending } = scriptedLLM(steps);
  const clock = extra.clock ?? testClock();
  await using agent = await makeBrain(testBrain(dir, llm, { ...extra, clock }));
  const events: BrainEvent[] = [];
  const sub = agent.events();
  const reading = (async () => {
    for await (const e of sub) events.push(e);
  })();
  try {
    return await body({
      agent,
      events,
      requests,
      script: { append, pending },
      clock,
      has: (type) => events.some((e) => e.type === type),
      ask: async (text: string) => {
        const answer = await agent.ask(userMessage(text, clock.now()));
        const current = agent.progress().current;
        // A current run that is not settled began after ask's, so the answered run is the one before it.
        const target = current.settled ? current.id : current.id - 1;
        await waitFor(
          () => events.some((e) => e.type === "agent_settled" && e.run.id === target),
          (consumed) => consumed,
          () =>
            `agent_settled target=${target} current=${agent.progress().current.id}; events=${events
              .slice(-12)
              .map((e) => (e.type === "agent_settled" ? `${e.type}:${e.run.id}` : e.type))
              .join(",")}`,
        );
        return answer;
      },
    });
  } finally {
    await agent.close();
    await reading;
  }
}
