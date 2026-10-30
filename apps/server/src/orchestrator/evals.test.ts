import { assistantMessage, toolCall } from "@vibevalley/ai/testing";
import type { BrainMessage } from "@vibevalley/agent/messages";
import { describe, expect, it } from "vite-plus/test";
import { check, committed, type Expect, casesIn, isInput, kinds, orchestratorToolNames, problemOf, stubbed } from "./evals.ts";
import { noResult } from "./prompts.ts";
import { Effect } from "effect";
import type { Tool } from "@vibevalley/agent/core/loop";

const call = assistantMessage([toolCall("issue_create", { title: "加个 README", project: "demo", start: true }, "c1")]);
const turn: BrainMessage[] = [
  call,
  { role: "toolResult", toolCallId: "c1", toolName: "issue_create", content: [{ type: "text", text: "派了" }], isError: false, timestamp: 0 },
  assistantMessage("派给了 Kimi"),
];
const quiet = turn.slice(0, 2);

describe("the orchestrator's evals", () => {
  it("judge every kind", () => {
    const passed = new Set<string>();
    const cases: [Expect, BrainMessage[], boolean][] = [
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
    expect([...passed].toSorted()).toEqual([...kinds].toSorted());
  });

  // Each committed case is red on the turn it recorded: its expect catches the error it was saved for.
  it("hold cases that catch their error", () => {
    const cases = casesIn(committed);
    expect(cases.length).toBeGreaterThan(0);
    const tools = orchestratorToolNames();
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

  // A replay answers a call only as the case recorded that same call: the recorded turn is the wrong one, and its answer to a
  // start the model was told not to make would tell the model it made one.
  it("answer in a replay only the call the case recorded, once", async () => {
    const issueCreate: Tool = { name: "issue_create", description: "", parameters: {}, execute: () => Effect.die("not stubbed") };
    const recorded: BrainMessage[] = [
      assistantMessage([toolCall("issue_create", { title: "白屏", start: true }, "c1"), toolCall("issue_create", { title: "坏了" }, "c2")]),
      { role: "toolResult", toolCallId: "c1", toolName: "issue_create", content: [{ type: "text", text: "派了" }], isError: false, timestamp: 0 },
      { role: "toolResult", toolCallId: "c2", toolName: "issue_create", content: [{ type: "text", text: "没记" }], isError: true, timestamp: 0 },
    ];
    const [tool] = stubbed([issueCreate], recorded);
    const answer = (args: unknown) =>
      Effect.runPromise(
        tool!.execute(args, { id: "x" }).pipe(
          Effect.map((r) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("")),
          Effect.catch((e: Error) => Effect.succeed("error: " + e.message)),
        ),
      );
    expect(await answer({ title: "白屏" })).toBe(noResult);
    expect(await answer({ start: true, title: "白屏" })).toBe("派了");
    expect(await answer({ title: "白屏", start: true })).toBe(noResult);
    expect(await answer({ title: "坏了" })).toBe("error: 没记");
  });
});
