import type { Event } from "@botiverse/oar";
import type { Agent, Doing, Session } from "@vibevalley/protocol";
import { clip } from "@vibevalley/protocol/rules";
import { describe, expect, it } from "vite-plus/test";
import { inCny } from "../runtime/price.ts";
import { eventFacts, type FactContext, near, since, type Tracking } from "./facts.ts";
import { asksOf, checksOf, chooseAgent, jobBreak, noRoom, readReport, recallHead, sessionName, summaryOf, withRecall } from "./rules.ts";
import { shellCommand } from "./shell.ts";

const ev = (body: object): Event => ({ sessionId: "s", agentPath: [], seq: 0, receivedAt: 0, ...body }) as unknown as Event;
const ctx: FactContext = { id: "w1", runtime: "pi", cwd: "/work/clock-in" };
const base = (): Session =>
  ({ id: "w1", name: "老周", agent: "zhou", runtime: "pi", brief: "加接口", project: "clock-in", phase: { _tag: "arriving" } }) as Session;
const working = (doing: Doing): Session => ({ ...base(), phase: { _tag: "working", doing } }) as Session;
const thinking: Doing = { action: "thinking", label: "" };
const none: Tracking = {};

describe("a session's events", () => {
  it("a run starts with the job and counts from what was spent", () => {
    const h = { ...base(), spent: { tokens: 50, cny: 0.1 } };
    const r = eventFacts(ev({ kind: "turn_started", requestId: "r", input: "你是老周" + jobBreak + "加一个查询接口" }), h, none, ctx);
    expect(r.facts).toEqual([{ type: "run", id: "w1" }]);
    expect(r.journal).toEqual([{ type: "prompt", text: "加一个查询接口" }]);
    expect(r.tracking.runFrom).toEqual({ tokens: 50, cny: 0.1 });
  });

  it("a run is reminded of memories", () => {
    const block = recallHead + "你以前记下的……\n- （这个项目）测试用 pnpm test";
    const r = eventFacts(ev({ kind: "turn_started", requestId: "r", input: "你是老周" + jobBreak + withRecall(block, "加一个查询接口") }), base(), none, ctx);
    expect(r.journal).toEqual([
      { type: "prompt", text: "加一个查询接口" },
      { type: "note", kind: "memory/recalled", text: "- （这个项目）测试用 pnpm test" },
    ]);
  });

  it("a command shows from its folder", () => {
    const started = eventFacts(
      ev({ kind: "tool_call_started", callId: "c1", tool: "bash", input: `{"command":"cd /work/clock-in && pnpm test"}` }),
      working(thinking),
      none,
      ctx,
    );
    expect(started.facts).toEqual([{ type: "doing", id: "w1", action: "run_command", label: "pnpm test" }]);
    expect(started.journal[0]!.type).toBe("toolStarted");
    expect(started.tracking.shownCall).toEqual({ id: "c1", tool: "bash" });
    const same = eventFacts(
      ev({ kind: "tool_call_started", callId: "c2", tool: "bash", input: `{"command":"pnpm test"}` }),
      working({ action: "run_command", label: "pnpm test" }),
      none,
      ctx,
    );
    expect(same.facts).toEqual([]);
    const failed = eventFacts(
      ev({ kind: "tool_call_ended", callId: "c1", exitCode: 1, content: [{ type: "text", text: "1 failing" }] }),
      working({ action: "run_command", label: "pnpm test" }),
      started.tracking,
      ctx,
    );
    expect(failed.journal).toEqual([{ type: "toolEnded", callId: "c1", output: "1 failing", ok: false }]);
    expect(failed.facts).toEqual([{ type: "doing", id: "w1", action: "thinking", label: "" }]);
  });

  it("the full input names the target better", () => {
    const input = `{"path":"/work/clock-in/src/http.ts"}`;
    const r = eventFacts(
      ev({ kind: "tool_call_input", callId: "c1", input }),
      working({ action: "read_file", label: "read" }),
      { shownCall: { id: "c1", tool: "read" } },
      ctx,
    );
    expect(r.journal).toEqual([{ type: "toolInput", callId: "c1", input, text: "src/http.ts" }]);
    expect(r.facts).toEqual([{ type: "doing", id: "w1", action: "read_file", label: "src/http.ts" }]);
  });

  it("reasoning is a step when shown", () => {
    const r = eventFacts(
      ev({ kind: "reasoning", content: { kind: "text", text: "先看看路由在哪" } }),
      working({ action: "read_file", label: "a.ts" }),
      none,
      ctx,
    );
    expect(r.journal).toEqual([{ type: "thought", text: "先看看路由在哪" }]);
    expect(r.facts).toEqual([{ type: "doing", id: "w1", action: "thinking", label: "" }]);
    expect(eventFacts(ev({ kind: "reasoning", content: { kind: "redacted" } }), working(thinking), none, ctx).journal).toEqual([]);
  });

  it("a sub-agent's steps say whose", () => {
    expect(eventFacts(ev({ kind: "text_delta", text: "好" }), working(thinking), none, ctx).journal).toEqual([{ type: "response", text: "好" }]);
    const sub = eventFacts(ev({ kind: "tool_call_started", callId: "c1", tool: "bash", input: "{}", agentPath: ["task-1"] }), working(thinking), none, ctx);
    expect(sub.journal[0]!.from).toEqual(["task-1"]);
  });

  it("not working, no bubble", () => {
    const h = { ...base(), phase: { _tag: "resting" } } as Session;
    for (const body of [
      { kind: "reasoning", content: { kind: "empty" } },
      { kind: "text_delta", text: "好的" },
    ])
      expect(eventFacts(ev(body), h, none, ctx).facts).toEqual([]);
  });

  it("spending is counted from the last total", () => {
    const rate = inCny({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, 7);
    const usage = (input: number, output: number) => ev({ kind: "usage", usage: { tokens: { input, output, cacheRead: 0, cacheWrite: 0 } } });
    const first = eventFacts(usage(1_000_000, 0), working(thinking), { rate }, ctx);
    expect(first.spentCny).toBe(7);
    expect(first.facts).toEqual([{ type: "spent", id: "w1", spent: { tokens: 1_000_000, cny: 7 } }]);
    const second = eventFacts(usage(1_000_000, 500_000), { ...working(thinking), spent: { tokens: 1_000_000, cny: 7 } }, first.tracking, ctx);
    expect(second.spentCny).toBe(7);
    expect(second.facts).toEqual([{ type: "spent", id: "w1", spent: { tokens: 1_500_000, cny: 14 } }]);
    const unpriced = eventFacts(ev({ kind: "usage", usage: { tokens: { input: 10, output: 5 } } }), working(thinking), none, ctx);
    expect([unpriced.spentCny, unpriced.facts]).toEqual([0, [{ type: "spent", id: "w1", spent: { tokens: 15 } }]]);
    expect(since({ tokens: 30, cny: 3 }, { tokens: 10, cny: 1 })).toEqual({ tokens: 20, cny: 2 });
    expect(since({ tokens: 30 }, undefined)).toBeUndefined();
  });

  it("a quiet spell ends with a word, not with usage", () => {
    const doing: Doing = { action: "run_command", label: "pnpm build" };
    const usage = eventFacts(ev({ kind: "usage", usage: {} }), working(doing), { quiet: true }, ctx);
    expect([usage.tracking.quiet, usage.facts]).toEqual([true, []]);
    const word = eventFacts(ev({ kind: "text_delta", text: "构建完了" }), working(doing), { quiet: true }, ctx);
    expect(word.tracking.quiet).toBe(false);
    expect(word.facts).toEqual([
      { type: "doing", id: "w1", ...doing },
      { type: "doing", id: "w1", action: "speaking_text", label: "" },
    ]);
  });

  it("retries, model failures and exits are said", () => {
    const retry = eventFacts(ev({ kind: "retry", attempt: 2, maxAttempts: 3, delayMs: 1500, reason: "429" }), working(thinking), none, ctx);
    expect(retry.facts).toEqual([{ type: "retry", id: "w1", attempt: 2, of: 3 }]);
    expect(retry.journal).toEqual([{ type: "note", kind: "llm/retry", text: "调用模型没成功，第 2/3 次重试，2 秒后：429" }]);
    expect(eventFacts(ev({ kind: "model", model: "deepseek-flash" }), working(thinking), none, ctx).model).toBe("deepseek-flash");
    const failed = eventFacts(
      ev({ kind: "turn_ended", outcome: { kind: "failed", failure: "billing", reason: "Insufficient Balance" } }),
      working(thinking),
      none,
      ctx,
    );
    expect(failed.journal[0]!.type).toBe("note");
    expect((failed.journal[0] as { text: string }).text).toMatch(/^余额不够了：Insufficient Balance/);
    const exited = eventFacts(ev({ kind: "exited", code: 137 }), { ...working(thinking), runs: 2 }, none, ctx);
    expect(exited.facts).toEqual([{ type: "report", id: "w1", outcome: "failed", summary: "pi 进程退出了（退出码 137）", runs: 2 }]);
    expect(exited.warn).toBe("老周 的 pi 进程退出了（退出码 137）");
    expect(eventFacts(ev({ kind: "exited", code: 0 }), { ...base(), phase: { _tag: "ripe" } } as Session, none, ctx).facts).toEqual([]);
  });

  it("near", () => {
    expect(near("/work/p", "/work/p/src/a.ts")).toBe("src/a.ts");
    expect(near("/work/p", "/work/p")).toBe(".");
    expect(near("/work/p", "/etc/hosts")).toBe("/etc/hosts");
    expect(near("/work/p", "cd /work/p && pnpm test")).toBe("pnpm test");
    expect(near("/work/p", "cat /work/p/README.md")).toBe("cat README.md");
  });
});

describe("a run's report", () => {
  it("the summary is the verdict", () => {
    const text = ["读了 src/http.ts。", "**结论：** 两个路由，POST /api/clock-in 和 POST /api/clock-out。", "（另外可选：README 第 3 行可以补个链接。）"].join(
      "\n\n",
    );
    expect(summaryOf(text)).toBe("两个路由，POST /api/clock-in 和 POST /api/clock-out。");
    expect(summaryOf("前面的话\n\n- 结论：做完了，commit abc123")).toBe("做完了，commit abc123");
    expect(summaryOf("开头在看代码。\n\n最后：一切正常，测试 28 个都过了。")).toMatch(/测试 28 个都过了/);
  });

  it("a completed run is read", () => {
    expect(readReport({ kind: "completed" }, "  改了路由。\n\n结论：加好了，commit abc123  ")).toEqual({
      outcome: "completed",
      text: "改了路由。\n\n结论：加好了，commit abc123",
      summary: "加好了，commit abc123",
      failure: "",
      needsYou: false,
      asks: [],
      checks: [],
    });
    expect(readReport({ kind: "completed" }, "").summary).toBe("做完了");
    expect(readReport({ kind: "aborted" }, "").outcome).toBe("interrupted");
    expect(readReport({ kind: "aborted" }, "").summary).toBe("没做完");
  });

  it("a failed run leads with why", () => {
    const billing = readReport({ kind: "failed", failure: "billing", reason: "Insufficient Balance", status: 402 }, "先看了看代码");
    expect([billing.outcome, billing.needsYou]).toEqual(["failed", true]);
    expect(billing.failure).toMatch(/^余额不够了（HTTP 402）：Insufficient Balance/);
    expect(billing.summary).toBe(clip(billing.failure, 160));
    expect(billing.text).toBe(billing.failure + "\n\n先看了看代码");
    expect(readReport({ kind: "failed", failure: "overloaded", reason: "" }, "").needsYou).toBe(false);
  });

  it("clip", () => {
    expect(clip("a\n  b", 10)).toBe("a b");
    expect(clip("abcdefghij", 5)).toBe("abcd…");
  });

  it("asks are the lines for the owner", () => {
    expect(asksOf("看了一下。\n\n要问主人：用 8787 还是 8797？\n- **要问主人**：要不要顺手改文档？\n\n结论：先停下等回答。")).toEqual([
      { question: "用 8787 还是 8797？" },
      { question: "要不要顺手改文档？" },
    ]);
    expect(asksOf("结论：做完了")).toEqual([]);
  });

  it("a question may end with its options; one option is no choice", () => {
    expect(
      asksOf("要问主人：全交给 w3，还是分着做？（选项：全交给 w3｜分着做）\n要问主人：端口？(选项: 8787 | 8797 |)\n要问主人：就这样？（选项：好）"),
    ).toEqual([
      { question: "全交给 w3，还是分着做？", options: ["全交给 w3", "分着做"] },
      { question: "端口？", options: ["8787", "8797"] },
      { question: "就这样？" },
    ]);
  });

  it("checks are its word on each criterion, by number", () => {
    const said = "标准 1：做到了 —— bun test 通过\n- **标准 2**：没做到，还差文档\n标准3：不确定\n标准 1：做到了。再跑一遍也过\n标准 0：做到了\n\n结论：做完了";
    expect(checksOf(said)).toEqual([
      { criterion: 0, result: "met", proof: "再跑一遍也过" },
      { criterion: 1, result: "unmet", proof: "还差文档" },
      { criterion: 2, result: "unsure" },
    ]);
  });
});

describe("room and names", () => {
  const h = (id: string, runtime: string, project: string, busy: boolean) =>
    ({ id, name: id, agent: "zhou", runtime, project, phase: busy ? { _tag: "working", doing: thinking } : { _tag: "ripe" } }) as Session;
  const limits = { workspace: 3, perRuntime: 2, perProject: 2 };

  it("room in the workspace", () => {
    expect(noRoom([], "pi", "a", limits)).toBe("");
    expect(noRoom([h("w1", "pi", "a", true), h("w2", "claude", "b", true), h("w3", "codex", "c", true)], "pi", "a", limits)).toMatch(/已经有 3 个帮工在干活了/);
    expect(noRoom([h("w1", "pi", "a", true), h("w2", "pi", "b", true)], "pi", "c", limits)).toMatch(/最多同时 2 个（在 Runtime 页面可以改）/);
    expect(noRoom([h("w1", "pi", "a", true), h("w2", "claude", "a", true)], "codex", "a", limits)).toMatch(/项目 a 里已经有 2 个帮工在干活/);
    const two = [h("w1", "pi", "a", true), h("w2", "pi", "a", true)];
    expect(noRoom([h("w1", "pi", "a", false), h("w2", "pi", "a", false)], "pi", "a", limits)).toBe("");
    expect(noRoom(two, "pi", "a", limits)).not.toBe("");
    expect(noRoom(two, "pi", "a", { workspace: 6, perRuntime: 0, perProject: 0 })).toBe("");
    expect(noRoom(two, "pi", "a", { workspace: 3, perRuntime: 3, perProject: 3 }, "w1")).toBe("");
  });

  it("session names", () => {
    expect(sessionName([], "zhou", "老周")).toBe("老周");
    expect(sessionName([h("w1", "pi", "a", true)], "zhou", "老周")).toBe("老周 2");
    expect(sessionName([h("w1", "pi", "a", true), h("w2", "pi", "a", true)], "zhou", "老周")).toBe("老周 3");
  });

  it("choose a profile", () => {
    const a = { id: "a", name: "甲", runtime: "pi", tags: ["前端"] } as Agent;
    const b = { id: "b", name: "乙", runtime: "claude", tags: ["测试", "后端"] } as Agent;
    const candidates = [
      { agent: a, usable: true },
      { agent: b, usable: true },
    ];
    expect(chooseAgent(candidates, "随便", "乙", "")?.id).toBe("b");
    expect(chooseAgent(candidates, "随便", "claude", "")?.id).toBe("b");
    expect(chooseAgent(candidates, "随便", "", "b")?.id).toBe("b");
    expect(chooseAgent(candidates, "补后端测试", "", "")?.id).toBe("b");
    expect(chooseAgent(candidates, "随便", "", "")?.id).toBe("a");
  });
});

describe("shell", () => {
  // The wanted values are what a real shell prints for `printf '%s\n' <argument>`.
  it.each([
    [`/bin/zsh -lc 'git diff --check && git status'`, `git diff --check && git status`],
    [`/bin/zsh -lc "rg -n '"'"'^##'"'"' docs/server.md"`, `rg -n '"^##"' docs/server.md`],
    [`/bin/zsh -lc 'echo '"'"'hi'"'"''`, `echo 'hi'`],
    [`bash -c 'it'\\''s'`, `it's`],
    [`/bin/bash -lc "echo \\"\\$HOME\\""`, `echo "$HOME"`],
    [`git status`, `git status`],
    [`/bin/zsh -lc ls`, `ls`],
    [`/bin/zsh -lc 'unterminated`, `/bin/zsh -lc 'unterminated`],
    [`/bin/zsh -lc 'a' b`, `/bin/zsh -lc 'a' b`],
  ])("%s", (input, want) => expect(shellCommand(input)).toBe(want));
});
