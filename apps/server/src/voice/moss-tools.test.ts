import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { extractMossToolAck, extractMossToolCalls } from "./moss-tools.ts";

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect("extracts ask_orchestrator tool calls from MOSS frames", () =>
  Effect.gen(function* () {
    const frame = yield* json({
      action: "response.function_call_arguments.done",
      data: {
        call_id: "call-1",
        name: "ask_orchestrator",
        arguments: yield* json({ question: "地里有哪些帮工在忙？" }),
      },
    });
    expect(extractMossToolCalls(frame)).toEqual([
      {
        callId: "call-1",
        name: "ask_orchestrator",
        question: "地里有哪些帮工在忙？",
      },
    ]);
    const attached = yield* json({ action: "session_attached" });
    expect(extractMossToolCalls(attached)).toEqual([]);
  }),
);

it.effect("regression: accepts official response.done summaries and deduplicates calls within them", () =>
  Effect.gen(function* () {
    const call = { type: "function_call", status: "completed", call_id: "c1", name: "ask_orchestrator", arguments: yield* json({ question: "status" }) };
    const done = yield* json({
      action: "response.done",
      data: { type: "response.done", response: { id: "r1", status: "completed", output: [call, call] } },
    });
    expect(extractMossToolCalls(done)).toEqual([{ callId: "c1", name: "ask_orchestrator", question: "status" }]);
  }),
);

it.effect("regression: rejects undocumented aliases, missing IDs, and malformed tool arguments", () =>
  Effect.gen(function* () {
    for (const action of ["tool.call", "function_call"]) {
      const alias = yield* json({ action, data: { call_id: "c1", name: "ask_orchestrator", arguments: '{"question":"status"}' } });
      expect(extractMossToolCalls(alias)).toEqual([]);
    }
    for (const args of ["not JSON", "{}", '{"text":"unvalidated"}', '{"question":123}']) {
      const malformed = yield* json({ action: "response.function_call_arguments.done", data: { call_id: "c1", name: "ask_orchestrator", arguments: args } });
      expect(extractMossToolCalls(malformed)).toEqual([]);
    }
    const unnamed = yield* json({
      action: "response.function_call_arguments.done",
      data: { call_id: "", name: "ask_orchestrator", arguments: '{"question":"status"}' },
    });
    expect(extractMossToolCalls(unnamed)).toEqual([]);
  }),
);

it.effect("regression: recognizes only function result acknowledgements", () =>
  Effect.gen(function* () {
    const ack = yield* json({ action: "conversation.item.created", data: { item: { id: "i1", type: "function_call_output", call_id: "c1" } } });
    expect(extractMossToolAck(ack)).toBe("c1");
    const message = yield* json({ action: "conversation.item.created", data: { item: { type: "message", call_id: "c1" } } });
    expect(extractMossToolAck(message)).toBeUndefined();
  }),
);
