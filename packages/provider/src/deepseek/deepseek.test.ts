import { describe, expect, it } from "vite-plus/test";

import { encodeDeepSeekRequest } from "./request.ts";
import { decodeDeepSeekChunk, SseData } from "./response.ts";

describe("DeepSeek protocol", () => {
  it("encodes tool history and explicit thinking without an agent message contract", () => {
    expect(
      encodeDeepSeekRequest("selected-model", {
        messages: [
          { role: "assistant", content: null, reasoning: { signature: "reasoning_text", text: "prior" }, calls: [{ id: "c", name: "f", arguments: "{}" }] },
        ],
        maxTokens: 17,
        tools: [],
        reasoning: true,
        thinking: true,
        effort: "max",
        toolChoice: "auto",
      }),
    ).toEqual({
      model: "selected-model",
      messages: [
        {
          role: "assistant",
          content: null,
          reasoning_text: "prior",
          reasoning_content: "",
          tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }],
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 17,
      tools: [],
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      tool_choice: "auto",
    });
  });

  it("retains proxy reasoning signatures and choice usage independently of optional metadata", () => {
    expect(
      decodeDeepSeekChunk({
        id: 42,
        choices: [
          {
            delta: { reasoning_text: "prior", content: "answer", tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] },
            finish_reason: "function_call",
            usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 20, completion_tokens_details: { reasoning_tokens: 2 } },
          },
        ],
      }),
    ).toEqual({
      thinking: { signature: "reasoning_text", text: "prior" },
      text: "answer",
      calls: [{ index: 0, arguments: '{"x":' }],
      finish: { raw: "function_call", reason: "tool" },
      usage: { input: 80, output: 5, cacheRead: 20, cacheWrite: 0, reasoning: 2, totalTokens: 105 },
    });
  });

  it("uses top-level cache details before aliases and reports unknown finish reasons", () => {
    const chunk = decodeDeepSeekChunk({
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 }, prompt_cache_hit_tokens: 20 },
      choices: [{ usage: { prompt_tokens: 999 }, finish_reason: "blocked" }],
    });
    expect(chunk.usage).toEqual({ input: 60, output: 5, cacheRead: 30, cacheWrite: 10, reasoning: 0, totalTokens: 105 });
    expect(chunk.finish).toEqual({ raw: "blocked", reason: "error", error: "Provider finish_reason: blocked" });
  });

  it("joins CRLF multiline data, skips comments and ignores events after DONE", () => {
    const sse = new SseData();
    const events = [": ping\r", "data: {\r", "data: }\r", "\r", "data: [DONE]\r", "\r", "data: ignored", ""].map((line) => sse.line(line));
    expect(events.filter((event) => event !== undefined)).toEqual(["{\n}"]);
    expect(sse.done).toBe(true);
  });
});
