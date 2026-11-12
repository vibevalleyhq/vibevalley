import { expect, test } from "vite-plus/test";

import { extractMossToolAck, extractMossToolCalls } from "./moss-tools.ts";

const json = (v: unknown) => JSON.stringify(v);

test("extracts ask_orchestrator tool calls from MOSS frames", () => {
  const frame = json({
    action: "response.function_call_arguments.done",
    data: {
      call_id: "call-1",
      name: "ask_orchestrator",
      arguments: json({ question: "地里有哪些帮工在忙？" }),
    },
  });
  expect(extractMossToolCalls(frame)).toEqual([
    {
      callId: "call-1",
      name: "ask_orchestrator",
      question: "地里有哪些帮工在忙？",
    },
  ]);
  const attached = json({ action: "session_attached" });
  expect(extractMossToolCalls(attached)).toEqual([]);
});

test("regression: accepts official response.done summaries and deduplicates calls within them", () => {
  const call = { type: "function_call", status: "completed", call_id: "c1", name: "ask_orchestrator", arguments: json({ question: "status" }) };
  const done = json({
    action: "response.done",
    data: { type: "response.done", response: { id: "r1", status: "completed", output: [call, call] } },
  });
  expect(extractMossToolCalls(done)).toEqual([{ callId: "c1", name: "ask_orchestrator", question: "status" }]);
});

test("regression: rejects undocumented aliases, missing IDs, and malformed tool arguments", () => {
  for (const action of ["tool.call", "function_call"]) {
    const alias = json({ action, data: { call_id: "c1", name: "ask_orchestrator", arguments: '{"question":"status"}' } });
    expect(extractMossToolCalls(alias)).toEqual([]);
  }
  for (const args of ["not JSON", "{}", '{"text":"unvalidated"}', '{"question":123}']) {
    const malformed = json({ action: "response.function_call_arguments.done", data: { call_id: "c1", name: "ask_orchestrator", arguments: args } });
    expect(extractMossToolCalls(malformed)).toEqual([]);
  }
  const unnamed = json({
    action: "response.function_call_arguments.done",
    data: { call_id: "", name: "ask_orchestrator", arguments: '{"question":"status"}' },
  });
  expect(extractMossToolCalls(unnamed)).toEqual([]);
});

test("regression: recognizes only function result acknowledgements", () => {
  const ack = json({ action: "conversation.item.created", data: { item: { id: "i1", type: "function_call_output", call_id: "c1" } } });
  expect(extractMossToolAck(ack)).toBe("c1");
  const message = json({ action: "conversation.item.created", data: { item: { type: "message", call_id: "c1" } } });
  expect(extractMossToolAck(message)).toBeUndefined();
});
