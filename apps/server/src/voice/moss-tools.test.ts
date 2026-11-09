import { expect, it } from "vite-plus/test";

import { extractMossToolAck, extractMossToolCalls } from "./moss-tools.ts";

it("extracts ask_orchestrator tool calls from MOSS frames", () => {
  const frame = JSON.stringify({
    action: "response.function_call_arguments.done",
    data: {
      call_id: "call-1",
      name: "ask_orchestrator",
      arguments: JSON.stringify({ question: "地里有哪些帮工在忙？" }),
    },
  });
  expect(extractMossToolCalls(frame)).toEqual([
    {
      callId: "call-1",
      name: "ask_orchestrator",
      question: "地里有哪些帮工在忙？",
    },
  ]);
  expect(extractMossToolCalls(JSON.stringify({ action: "session_attached" }))).toEqual([]);
});

it("regression: accepts official response.done summaries and deduplicates calls within them", () => {
  const call = { type: "function_call", status: "completed", call_id: "c1", name: "ask_orchestrator", arguments: JSON.stringify({ question: "status" }) };
  expect(
    extractMossToolCalls(
      JSON.stringify({
        action: "response.done",
        data: { type: "response.done", response: { id: "r1", status: "completed", output: [call, call] } },
      }),
    ),
  ).toEqual([{ callId: "c1", name: "ask_orchestrator", question: "status" }]);
});

it("regression: rejects undocumented aliases, missing IDs, and malformed tool arguments", () => {
  for (const action of ["tool.call", "function_call"]) {
    expect(extractMossToolCalls(JSON.stringify({ action, data: { call_id: "c1", name: "ask_orchestrator", arguments: '{"question":"status"}' } }))).toEqual([]);
  }
  for (const args of ["not JSON", "{}", '{"text":"unvalidated"}', '{"question":123}']) {
    expect(
      extractMossToolCalls(
        JSON.stringify({ action: "response.function_call_arguments.done", data: { call_id: "c1", name: "ask_orchestrator", arguments: args } }),
      ),
    ).toEqual([]);
  }
  expect(
    extractMossToolCalls(
      JSON.stringify({ action: "response.function_call_arguments.done", data: { call_id: "", name: "ask_orchestrator", arguments: '{"question":"status"}' } }),
    ),
  ).toEqual([]);
});

it("regression: recognizes only function result acknowledgements", () => {
  expect(
    extractMossToolAck(JSON.stringify({ action: "conversation.item.created", data: { item: { id: "i1", type: "function_call_output", call_id: "c1" } } })),
  ).toBe("c1");
  expect(extractMossToolAck(JSON.stringify({ action: "conversation.item.created", data: { item: { type: "message", call_id: "c1" } } }))).toBeUndefined();
});
