import { rmSync } from "node:fs";

import { Effect, Stream } from "effect";

import type { ModelClient } from "@vibevalley/ai/client";
import type { Message } from "@vibevalley/ai/messages";
import { type Reply, type Request, scriptedLlm, type Step, testModel } from "@vibevalley/ai/testing";
import { tempDir } from "@vibevalley/testkit/temp";

import { type Brain, type BrainEvent, type BrainOptions, makeBrain } from "./brain.ts";
import { codingTools } from "./coding.ts";
import type { AgentClosed } from "./core/errors.ts";
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
  const dir = tempDir("vibevalley-agent-");
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface Rig {
  readonly agent: Brain;
  readonly events: BrainEvent[];
  readonly requests: Request[];
  readonly script: Pick<ReturnType<typeof scriptedLLM>, "append" | "pending">;
  readonly has: (type: BrainEvent["type"]) => boolean;
  readonly ask: (text: string) => Effect.Effect<string, AgentClosed>;
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

/** A brain on the test's fibers (its Clock is the test's), closed once body is done, before what follows it. */
export const withAgent = <A, E, R>(dir: string, steps: readonly Step[], body: (r: Rig) => Effect.Effect<A, E, R>, extra: Partial<BrainOptions> = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { llm, requests, append, pending } = scriptedLLM(steps);
      const agent = yield* makeBrain(testBrain(dir, llm, extra));
      const events: BrainEvent[] = [];
      yield* Effect.forkScoped(Stream.runForEach(yield* agent.events, (e) => Effect.sync(() => void events.push(e))));
      return yield* body({
        agent,
        events,
        requests,
        script: { append, pending },
        has: (type) => events.some((e) => e.type === type),
        // The events go out on a hub: the reader takes what was published before the answer once it has a turn.
        ask: (text) => Effect.tap(agent.ask(userMessage(text, Date.now())), () => Effect.andThen(Effect.yieldNow, Effect.yieldNow)),
      });
    }),
  );
