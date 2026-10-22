import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vite-plus/test";
import { check, committed, type Expect, casesIn, isInput, kinds, assistantToolNames, problemOf } from "./evals.ts";

const call = fauxAssistantMessage(fauxToolCall("dispatch", { project: "demo", brief: "加个 README" }, { id: "c1" }));
const turn: AgentMessage[] = [
  call,
  { role: "toolResult", toolCallId: "c1", toolName: "dispatch", content: [{ type: "text", text: "派了" }], isError: false, timestamp: 0 },
  fauxAssistantMessage("派给了 Kimi"),
];
const quiet = turn.slice(0, 2);

describe("the assistant's evals", () => {
  it("judge every kind", () => {
    const passed = new Set<string>();
    const cases: [Expect, AgentMessage[], boolean][] = [
      [{ kind: "called", tool: "dispatch" }, turn, true],
      [{ kind: "called", tool: "dispatch", argContains: `"project":"demo"` }, turn, true],
      [{ kind: "called", tool: "dispatch", argContains: `"project":"notes"` }, turn, false],
      [{ kind: "called", tool: "task" }, turn, false],
      [{ kind: "notCalled", tool: "task" }, turn, true],
      [{ kind: "notCalled", tool: "dispatch" }, turn, false],
      [{ kind: "silent" }, quiet, true],
      [{ kind: "silent" }, turn, false],
      [{ kind: "says", contains: "Kimi" }, turn, true],
      [{ kind: "says", contains: "Kimi" }, quiet, false],
      [{ kind: "saysNot", contains: "Kimi" }, quiet, true],
      [{ kind: "saysNot", contains: "Kimi" }, turn, false],
      [{ kind: "called" }, turn, false],
      [{ kind: "says" }, turn, false],
      [{ kind: "maybe" }, turn, false],
    ];
    for (const [e, on, pass] of cases) {
      expect({ e, passes: check([e], on).length === 0 }).toEqual({ e, passes: pass });
      if (pass) passed.add(e.kind);
    }
    expect([...passed].sort()).toEqual([...kinds].sort());
  });

  // Each committed case is red on the turn it recorded: its expect catches the error it was saved for.
  it("hold cases that catch their error", () => {
    const cases = casesIn(committed);
    expect(cases.length).toBeGreaterThan(0);
    const tools = assistantToolNames();
    for (const { file, case: c } of cases) {
      expect({ file, id: !!c.id, want: !!c.want, model: !!c.model, input: isInput(c.input), expect: c.expect.length > 0 }).toEqual({
        file,
        id: true,
        want: true,
        model: true,
        input: true,
        expect: true,
      });
      for (const e of c.expect) {
        expect({ file, problem: problemOf(e) }).toEqual({ file, problem: "" });
        if (e.tool) expect(tools).toContain(e.tool);
      }
      expect({ file, missed: check(c.expect, c.did).length > 0 }).toEqual({ file, missed: true });
    }
  });
});
