import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { describe, expect, test } from "vite-plus/test";

import { Secret } from "@vibevalley/protocol/schema";

import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { noDeepSeekKey } from "#/modules/agent/agent.ts";

import { deepseekAccess, type Durable, entryMessage, openDurable } from "./durable.ts";

const context = BACKGROUND_CONTEXT;

/** DeepSeek's stream as it comes on the wire: one data line a chunk, then [DONE]. */
const sse = (chunks: readonly unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

/** Thinking, then one tool call whose id comes after its name, and the usage inside the choice (as DeepSeek's proxies
 * send it). */
const toolTurn = sse([
  { id: "r1", model: "deepseek-flash", choices: [{ index: 0, delta: { role: "assistant", content: null, reasoning_content: "先看" } }] },
  { id: "r1", choices: [{ index: 0, delta: { reasoning_content: "看地" } }] },
  { id: "r1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: "function", function: { name: "look", arguments: "" } }] } }] },
  { id: "r1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { arguments: '{"what":' } }] } }] },
  { id: "r1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"地"}' } }] } }] },
  {
    id: "r1",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "tool_calls",
        usage: { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 100, completion_tokens_details: { reasoning_tokens: 12 } },
      },
    ],
  },
]);

const answerTurn = sse([
  { id: "r2", choices: [{ index: 0, delta: { role: "assistant", content: "三块地都好" } }] },
  { id: "r2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 160, completion_tokens: 6, prompt_cache_hit_tokens: 120 } },
]);

/** A fetch that answers each request with the next recorded stream, and keeps what was sent. */
function recorded(streams: readonly string[]) {
  const sent: { readonly body: Record<string, unknown>; readonly auth: string | null }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    sent.push({ body: (await request.json()) as Record<string, unknown>, auth: request.headers.get("authorization") });
    const next = streams[sent.length - 1];
    if (next === undefined) return new Response("no more recorded answers", { status: 500 });
    return new Response(next, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetcher, sent };
}

const look = defineTool({
  name: "look",
  description: "看一块地",
  parameters: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
  execute: async () => ({ output: [{ type: "text", text: "三块地在长" }] }),
});
const extension = defineExtension({ name: "test.look", tools: [look] });

async function ask(durable: Durable, key: string, thinkingLevel: "off" | "high" | "max") {
  durable.registry.install(extension);
  const conversation = await durable.conversation(key, { model: durable.model("").ref, extensions: [extension], thinkingLevel });
  const settled = await (await conversation.submit({ type: "input", content: "地里怎么样" }, context)).wait(context);
  const entries = (await conversation.entries({ order: "ascending" }, 100, undefined, context)).items;
  const answers = entries.flatMap((e) => {
    const m = entryMessage(e);
    return m?.role === "assistant" ? [m] : [];
  });
  return { settled, answers };
}

describe("pi-ai's DeepSeek provider under the harness, on recorded streams", () => {
  test("reads thinking, a late tool id and the choice's usage, and sends the tool turn back with content null and its reasoning", async () => {
    const { fetcher, sent } = recorded([toolTurn, answerTurn]);
    let key: Secret | undefined = new Secret("sk-first");
    const models = deepseekAccess({ key: () => key, fetch: fetcher, clock: wallTime });
    const durable = await openDurable({ file: undefined, clock: wallTime, log: keptLog(), models });
    try {
      durable.registry.install(extension);
      const conversation = await durable.conversation("wire", { model: durable.model("").ref, extensions: [extension], thinkingLevel: "max" });
      const first = await conversation.submit({ type: "input", content: "地里怎么样" }, context);
      const settled = await first.wait(context);
      expect(settled.status).toBe("done");
      const entries = (await conversation.entries({ order: "ascending" }, 100, undefined, context)).items;
      const answers = entries.flatMap((e): AssistantMessage[] => {
        const m = entryMessage(e);
        return m?.role === "assistant" ? [m] : [];
      });

      // The first answer: its thinking, one call (the id came after its name), the usage the choice carried.
      expect(answers).toHaveLength(2);
      const [called, said] = answers;
      expect(called!.content).toEqual([
        { type: "thinking", thinking: "先看看地", thinkingSignature: "reasoning_content" },
        { type: "toolCall", id: "call_1", name: "look", arguments: { what: "地" } },
      ]);
      expect(called!.usage).toMatchObject({ input: 20, cacheRead: 100, output: 30, reasoning: 12 });
      expect(called!.stopReason).toBe("toolUse");
      expect(said!.content).toEqual([{ type: "text", text: "三块地都好" }]);
      expect(said!.usage).toMatchObject({ input: 40, cacheRead: 120, output: 6 });

      expect(sent).toHaveLength(2);
      expect(sent[0]!.auth).toBe("Bearer sk-first");
      expect(sent[0]!.body).toMatchObject({ model: "deepseek-flash", stream: true, thinking: { type: "enabled" }, reasoning_effort: "max" });
      // The tool-only turn goes back with content null, its reasoning, and the one call.
      const replayed = (sent[1]!.body["messages"] as Record<string, unknown>[]).filter((m) => m["role"] === "assistant");
      expect(replayed).toEqual([
        {
          role: "assistant",
          content: null,
          reasoning_content: "先看看地",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "look", arguments: '{"what":"地"}' } }],
        },
      ]);
      expect((sent[1]!.body["messages"] as Record<string, unknown>[]).at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });

      // The key is read at each request: one saved meanwhile is the one sent, and none is a refusal in the user's words.
      key = undefined;
      expect(durable.cannotAsk()).toBe(noDeepSeekKey());
      const refused = await conversation.submit({ type: "input", content: "再看看" }, context);
      expect((await refused.wait(context)).status).toBe("unanswered");
      const last = (await conversation.entries({ order: "descending" }, 1, undefined, context)).items[0];
      const m = last === undefined ? undefined : entryMessage(last);
      expect(m).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: noDeepSeekKey() });
      expect(sent).toHaveLength(2);
    } finally {
      await durable.close();
    }
  });

  test("asks without thinking when the level is off, and with high as high", async () => {
    const plain = sse([
      { id: "r", choices: [{ index: 0, delta: { content: "好" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } },
    ]);
    const { fetcher, sent } = recorded([plain, plain]);
    const models = deepseekAccess({ key: () => new Secret("sk"), fetch: fetcher, clock: wallTime });
    const durable = await openDurable({ file: undefined, clock: wallTime, log: keptLog(), models });
    try {
      expect((await ask(durable, "off", "off")).settled.status).toBe("done");
      expect((await ask(durable, "high", "high")).settled.status).toBe("done");
      expect(sent[0]!.body).toMatchObject({ thinking: { type: "disabled" } });
      expect(sent[0]!.body).not.toHaveProperty("reasoning_effort");
      expect(sent[1]!.body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    } finally {
      await durable.close();
    }
  });

  test("names a model the catalog has, and the default one for any other", async () => {
    const models = deepseekAccess({ key: () => undefined, fetch: recorded([]).fetcher, clock: wallTime });
    const durable = await openDurable({ file: undefined, clock: wallTime, log: keptLog(), models });
    try {
      expect(durable.model("deepseek-v4-pro").ref).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro" });
      expect(durable.model("").ref).toEqual({ provider: "deepseek", modelId: "deepseek-flash" });
      expect(durable.model("deepseek-chat").ref).toEqual({ provider: "deepseek", modelId: "deepseek-flash" });
      expect(durable.model("").contextWindow).toBe(1_000_000);
    } finally {
      await durable.close();
    }
  });
});
