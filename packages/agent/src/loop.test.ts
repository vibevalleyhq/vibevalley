// How a run goes, turn by turn, as the brain's loop has gone: the spec the loop is held to when it changes
// (.agents/notes/proposed/architecture/2026-10-27-pi-in-effect.md, step 3).

import { whenTrue } from "@vibevalley/testkit/until";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { answer, text, toolCall } from "@vibevalley/ai/testing";
import { objectSchema } from "@vibevalley/ai/tools";
import { gate } from "@vibevalley/testkit/until";
import { messageText, userMessage } from "./messages.ts";
import { type Rig, results, tempHome, withAgent } from "./testing.ts";
import { textTool } from "./core/tool.ts";

const homes: (() => void)[] = [];
const home = () => {
  const h = tempHome();
  homes.push(h.done);
  return h.dir;
};
afterEach(() => {
  for (const done of homes.splice(0)) done();
});

const said = (r: Rig) => r.agent.history().map((m) => m.role + ":" + messageText(m));
/** The run's events by type, a message's by its role, the stream's updates once. */
const shape = (r: Rig) =>
  r.events
    .map((e) => ("message" in e && e.type.startsWith("message_") ? `${e.type}:${e.message.role}` : "toolName" in e ? `${e.type}:${e.toolName}` : e.type))
    .filter((e, i, all) => !(e.startsWith("message_update") && all[i - 1]?.startsWith("message_update")));

describe("a run's turns", () => {
  it("goes through its events in one order", async () => {
    await withAgent(home(), [answer([toolCall("list_dir", {})]), answer("好了")], async (r) => {
      await r.ask("列一下");
      await whenTrue(() => r.has("agent_settled"), 'r.has("agent_settled")');
      expect(shape(r)).toEqual([
        "agent_start",
        "turn_start",
        "message_start:user",
        "message_end:user",
        "message_start:assistant",
        "message_update:assistant",
        "message_end:assistant",
        "tool_execution_start:list_dir",
        "tool_execution_end:list_dir",
        "message_start:toolResult",
        "message_end:toolResult",
        "turn_end",
        "turn_start",
        "message_start:assistant",
        "message_update:assistant",
        "message_end:assistant",
        "turn_end",
        "agent_end",
        "agent_settled",
      ]);
    });
  });

  it("runs no tool call of an answer cut off at its length, and says why", async () => {
    let ran = 0;
    const counted = textTool<object>({ name: "counted", description: "", parameters: objectSchema(), run: () => String(++ran) });
    await withAgent(
      home(),
      [answer([toolCall("counted", {})], { stopReason: "length" }), answer("再来")],
      async (r) => {
        await r.ask("数");
        expect(ran).toBe(0);
        expect(results(r.requests[1]!)).toEqual([
          {
            failed: true,
            text: 'Tool call "counted" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.',
          },
        ]);
      },
      { tools: [counted] },
    );
  });

  it("answers a tool that is not there, and arguments a tool refuses, as failed calls", async () => {
    await withAgent(home(), [answer([toolCall("no_such_tool", {}), toolCall("read_file", { path: ["a"] })]), answer("知道了")], async (r) => {
      await r.ask("试试");
      expect(results(r.requests[1]!)).toEqual([
        { failed: true, text: "Tool no_such_tool not found" },
        { failed: true, text: 'Validation failed for tool "read_file":\n  - path: must be string\n\nReceived arguments:\n{\n  "path": [\n    "a"\n  ]\n}' },
      ]);
    });
  });

  it("takes the lines sent while it works one a turn", async () => {
    const wake = gate();
    let napping = false;
    const nap = textTool<object>({
      name: "nap",
      description: "",
      parameters: objectSchema(),
      run: async () => {
        napping = true;
        await wake.opened;
        return "醒了";
      },
    });
    await withAgent(
      home(),
      [answer([toolCall("nap", {})]), answer("一"), answer("二")],
      async (r) => {
        await r.agent.send(userMessage("开始", Date.now()));
        await whenTrue(() => napping, "napping");
        await r.agent.send(userMessage("甲", Date.now()));
        await r.agent.send(userMessage("乙", Date.now()));
        wake.open();
        await whenTrue(() => r.agent.history().length >= 7, "r.agent.history().length >= 7");
        expect(said(r)).toEqual(["user:开始", "assistant:", "toolResult:醒了", "user:甲", "assistant:一", "user:乙", "assistant:二"]);
      },
      { tools: [nap] },
    );
  });

  it("runs the tools of one answer side by side, and keeps their results in the order they were called", async () => {
    const slowDone = gate();
    let slowStarted = false;
    const slow = textTool<object>({
      name: "slow",
      description: "",
      parameters: objectSchema(),
      run: async () => {
        slowStarted = true;
        await slowDone.opened;
        return "慢的";
      },
    });
    const fast = textTool<object>({ name: "fast", description: "", parameters: objectSchema(), run: () => "快的" });
    await withAgent(
      home(),
      [answer([text("两个"), toolCall("slow", {}), toolCall("fast", {})]), answer("都好了")],
      async (r) => {
        await r.agent.send(userMessage("一起", Date.now()));
        await whenTrue(
          () => slowStarted && r.events.some((e) => e.type === "tool_execution_end" && e.toolName === "fast"),
          'slowStarted && r.events.some((e) => e.type === "tool_execution_end" && e.toolName === "fast")',
        );
        slowDone.open();
        await whenTrue(() => r.has("agent_settled"), 'r.has("agent_settled")');
        expect(r.events.flatMap((e) => (e.type === "tool_execution_start" || e.type === "tool_execution_end" ? [e.type + ":" + e.toolName] : []))).toEqual([
          "tool_execution_start:slow",
          "tool_execution_start:fast",
          "tool_execution_end:fast",
          "tool_execution_end:slow",
        ]);
        expect(said(r)).toEqual(["user:一起", "assistant:两个", "toolResult:慢的", "toolResult:快的", "assistant:都好了"]);
      },
      { tools: [slow, fast] },
    );
  });
});
