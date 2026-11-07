import { expect, it } from "vite-plus/test";

import { extractMossToolCall } from "./moss-tools.ts";

it("extracts ask_orchestrator tool calls from MOSS frames", () => {
  const frame = JSON.stringify({
    action: "response.function_call_arguments.done",
    data: {
      call_id: "call-1",
      name: "ask_orchestrator",
      arguments: JSON.stringify({ question: "地里有哪些帮工在忙？" }),
    },
  });
  expect(extractMossToolCall(frame)).toEqual({
    callId: "call-1",
    name: "ask_orchestrator",
    question: "地里有哪些帮工在忙？",
  });
  expect(extractMossToolCall(JSON.stringify({ action: "session_attached" }))).toBeUndefined();
});
