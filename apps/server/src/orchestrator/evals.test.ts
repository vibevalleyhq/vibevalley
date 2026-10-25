import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vite-plus/test";
import { check, committed, type Expect, casesIn, isInput, kinds, orchestratorToolNames, problemOf } from "./evals.ts";

const call = fauxAssistantMessage(fauxToolCall("issue_create", { title: "加个 README", project: "demo", start: true }, { id: "c1" }));
const turn: AgentMessage[] = [
  call,
  {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "issue_create",
    content: [{ type: "text", text: "派了" }],
    isError: false,
    timestamp: 0,
  },
  fauxAssistantMessage("派给了 Kimi"),
];
const quiet = turn.slice(0, 2);

describe("the orchestrator's evals", () => {
  it("judge every kind", () => {
    const passed = new Set<string>();
    const cases: [Expect, AgentMessage[], boolean][] = [
      [{ kind: "called", tool: "issue_create" }, turn, true],
      [{ kind: "called", tool: "issue_create", argContains: `"project":"demo"` }, turn, true],
      [{ kind: "called", tool: "issue_create", argContains: `"project":"notes"` }, turn, false],
      [{ kind: "called", tool: "issue_create", argLacks: `"start":true` }, turn, false],
      [{ kind: "called", tool: "issue_create", argLacks: `"draft":true` }, turn, true],
      [{ kind: "called", tool: "task" }, turn, false],
      [{ kind: "notCalled", tool: "task" }, turn, true],
      [{ kind: "notCalled", tool: "issue_create" }, turn, false],
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
    const tools = orchestratorToolNames();
    for (const { file, case: c } of cases) {
      expect({
        file,
        id: !!c.id,
        want: !!c.want,
        model: !!c.model,
        input: isInput(c.input),
        expect: c.expect.length > 0,
      }).toEqual({
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
