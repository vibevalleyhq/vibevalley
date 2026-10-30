import { join } from "node:path";

import { expect, it } from "@effect/vitest";

import { checkCases, goldenCasesAt } from "@vibevalley/testkit/golden";

import type { Context, Message, ToolDeclaration } from "./messages.ts";
import { models, type ThinkingLevel } from "./models.ts";
import { requestBody } from "./request.ts";
import { responseOf } from "./response.ts";

// First recorded from pi-ai 1.3.0's openai-completions, which this replaces: a change in what a request says or how a
// stream is read shows here.
const cases = goldenCasesAt(join(import.meta.dirname, "testdata", "deepseek.jsonl.gz"));
const model = (id: string) => models.find((m) => m.id === id)!;

/** The recorded input leads with pi-ai's system message, holding the prompt and the tools. */
function contextOf(messages: readonly (Message | { role: "system"; content: string; toolsAdded?: ToolDeclaration[] })[]): Context {
  const [head, ...rest] = messages;
  const system = head?.role === "system" ? head : undefined;
  return { system: system?.content ?? "", tools: system?.toolsAdded ?? [], messages: (system ? rest : messages) as Message[] };
}

it("asks DeepSeek as pi-ai did", () => {
  const failed = checkCases(
    cases.filter((c) => c.fn === "request"),
    (c) => {
      const i = c.in as { model: string; reasoning?: ThinkingLevel; messages: Parameters<typeof contextOf>[0] };
      return requestBody(model(i.model), contextOf(i.messages), i.reasoning ? { reasoning: i.reasoning } : {});
    },
  );
  expect(failed).toEqual([]);
});

it("reads DeepSeek's streams as pi-ai did", () => {
  const failed = checkCases(
    cases.filter((c) => c.fn === "response"),
    (c) => {
      const i = c.in as { model: string; sse: string };
      return responseOf(model(i.model), i.sse);
    },
  );
  expect(failed).toEqual([]);
});
