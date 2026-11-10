import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { Tool } from "@vibevalley/agent/core/loop";
import type { BrainMessage } from "@vibevalley/agent/messages";
import { assistantMessage, toolCall } from "@vibevalley/ai/testing";
import { executionsOf } from "@vibevalley/protocol/rules";

import { Issue } from "#/issue/issue.ts";
import {
  check,
  committed,
  type Expect,
  casesIn,
  isInput,
  kinds,
  orchestratorToolNames,
  problemOf,
  replaySetup,
  replayWorld,
  stubbed,
} from "#/testing/evals.ts";

import { noResult } from "./prompts.ts";

const call = assistantMessage([toolCall("issue_create", { title: "加个 README", repo: "demo", start: true }, "c1")]);
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
      [{ kind: "called", tool: "issue_create", argContains: `"repo":"demo"` }, turn, true],
      [{ kind: "called", tool: "issue_create", argContains: `"repo":"notes"` }, turn, false],
      [{ kind: "called", tool: "issue_create", argLacks: `"start":true` }, turn, false],
      [{ kind: "called", tool: "issue_create", argLacks: `"draft":true` }, turn, true],
      [{ kind: "called", tool: "task" }, turn, false],
      [{ kind: "notCalled", tool: "task" }, turn, true],
      [{ kind: "notCalled", tool: "issue_create" }, turn, false],
      [{ kind: "notCalled", tool: "issue_create", argContains: `"start":true` }, turn, false],
      [{ kind: "notCalled", tool: "issue_create", argContains: `"start":false` }, turn, true],
      [{ kind: "notCalled", tool: "issue_create", argLacks: `"start":true` }, turn, true],
      [{ kind: "silent" }, quiet, true],
      [{ kind: "silent" }, turn, false],
      [{ kind: "says", contains: "Kimi" }, turn, true],
      [{ kind: "says", contains: "Kimi" }, quiet, false],
      [{ kind: "saysNot", contains: "Kimi" }, quiet, true],
      [{ kind: "saysNot", contains: "Kimi" }, turn, false],
      [{ kind: "brief", maxChars: 60 }, turn, true],
      [{ kind: "brief", maxChars: 60 }, quiet, false],
      [{ kind: "brief", maxChars: 3 }, turn, false],
      [{ kind: "brief", maxChars: 60 }, [assistantMessage("Assigned lab to demo.")], true],
      [{ kind: "brief", maxChars: 60 }, [assistantMessage("Assigned.\nMore details.")], false],
      [{ kind: "brief", maxChars: 60 }, [assistantMessage("Assigned. More details.")], false],
      [{ kind: "brief", maxChars: 60 }, [assistantMessage("x".repeat(61))], false],
      [{ kind: "brief" }, turn, false],
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

  it("regression: a harmless future-tense reply cannot hide a forbidden start", () => {
    const c = casesIn(committed).find(({ case: item }) => item.id === "note-without-starting")?.case;
    if (!c) throw new Error("The note fixture is missing");
    const noted = [
      assistantMessage([toolCall("issue_list", { text: "白屏" }), toolCall("issue_create", { title: "登录页偶尔白屏", repo: "demo" })]),
      assistantMessage("记下了，需要时再派。"),
    ];
    expect(check(c.expect, noted)).toEqual([]);
    expect(check(c.expect, [...noted, call])).not.toEqual([]);
    expect(check(c.expect, [...noted, assistantMessage([toolCall("issue_create", { title: "白屏", draft: true })])])).not.toEqual([]);
    expect(check(c.expect, [...noted, assistantMessage([toolCall("issue_status_update", { id: "#1", status: "待办" })])])).not.toEqual([]);
  });

  it.live.each(casesIn(committed).filter(({ case: c }) => c.scenario !== undefined))(
    "regression: replay $case.id executes paraphrased requests in an isolated farm",
    ({ case: c }) =>
      Effect.gen(function* () {
        const repo = c.scenario?.repos[0];
        if (!repo) throw new Error("The replay repository is missing");
        const { tools } = yield* replaySetup(c);
        const issues = yield* Issue;
        const create = tools.find((tool) => tool.name === "issue_create");
        const list = tools.find((tool) => tool.name === "issue_list");
        if (!create || !list) throw new Error("Issue tools are missing");
        const issues2 = yield* issues.list();
        expect(issues2).toEqual([]);
        const before = yield* list.execute({ text: "白屏", repo }, { id: "read" });
        expect(before.content).not.toEqual([{ type: "text", text: noResult }]);
        const start = c.id !== "note-without-starting";
        const args = {
          title: c.id === "one-line-after-starting" ? "登录会话记忆" : c.id === "start-when-asked" ? "补充 README 文档" : "登录页间歇性白屏",
          description: c.id === "one-line-after-starting" ? "勾选后 token 保留 30 天；未勾选关闭浏览器即失效；登录测试通过" : "",
          repo,
          ...(start ? { start: true } : {}),
        };
        const receipt = yield* create.execute(args, { id: "create" });
        const added = yield* issues.list();
        expect(added).toHaveLength(1);
        const item = added[0];
        if (!item) throw new Error("The request did not create an issue");
        expect(item).toMatchObject({ title: args.title, description: args.description, repo: args.repo });
        expect(executionsOf(item)).toHaveLength(start ? 1 : 0);
        if (!start) expect(item.status).toBe("backlog");
        expect(receipt.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")).toContain(`#${item.number}`);
        const after = yield* list.execute({ text: args.title }, { id: "read-after" });
        expect(after.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")).toContain(`#${item.number}`);
      }).pipe(Effect.provide(replayWorld(c))),
  );

  // A replay answers a call only as the case recorded that same call.
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
