import { afterEach, expect, test } from "vite-plus/test";
import type { Issue, IssueAct, IssueAction, IssueAttention, Session, StateFrame } from "@vibevalley/protocol";
import { farmCommands } from "./commands";
import { farm, resetFarm } from "./store";
import { beds } from "./world/plots";
import type { Tool } from "./tools";
import { issueId, sessionId } from "@vibevalley/protocol/schema";

afterEach(resetFarm);

const buttons = (...names: IssueAct[]): IssueAction[] =>
  names.map((act): IssueAction => {
    switch (act) {
      case "tell":
      case "answer":
        return { act, does: "say" };
      case "stop":
        return { act, does: "stop" };
      case "complete":
      case "acknowledge":
        return { act, does: "move", status: "done", words: "none" };
      case "close":
        return { act, does: "move", status: "canceled", words: "none" };
      case "reject":
      case "reopen":
        return { act, does: "move", status: "todo", words: "required" };
      case "start":
      case "cure":
      case "resolve":
      case "resume":
        return { act, does: "move", status: "todo", words: "none" };
    }
  });

const helper: Session = {
  id: sessionId("helper"),
  name: "阿狐",
  agent: "fox",
  runtime: "pi",
  brief: "提交打卡页",
  hiredAt: 0,
  runs: 1,
  phase: { _tag: "done" },
  refining: false,
  issue: issueId("clock"),
  play: { station: 0, history: [], toolsThisRun: 0, counts: {}, files: [], commands: [] },
};

function frame(attention: IssueAttention, session: Session = helper): StateFrame {
  const issue: Issue = {
    id: issueId("clock"),
    number: 1,
    title: "提交打卡页",
    priority: "medium",
    deliver: "change",
    createdAt: 0,
    sessions: [session.id],
    status: "in_review",
    moves: [],
    findings: [],
    questions: [],
    blockedBy: [],
    criteria: [],
    checks: [],
    attention,
  };
  return {
    state: { call: "idle", sessions: [session], issues: [issue], orchestrators: {}, crons: [], connectors: [] },
    inbox: [],
    graphs: [],
    effects: [],
    view: { level: { level: 1, xp: 0, need: 100 }, plots: { clock: { crop: "wheat" } }, achievements: [] },
  };
}

const aim = (f: StateFrame, tool: Tool) => {
  farm.hold(tool);
  return farmCommands(() => f).aim(beds[0]!);
};

test("a crop is harvested exactly when the issue offers completing it", () => {
  const f = frame({ state: "asking", lead: "answer", acts: buttons("answer", "close") });
  expect(aim(f, "harvest").aim.ok).toBe(false);
  f.state.issues[0]!.attention = { state: "reviewing", lead: "complete", acts: buttons("complete", "tell", "close") };
  expect(aim(f, "harvest").aim.ok).toBe(true);
});

test("a failed round can be cured even before its crop image catches up", () => {
  const f = frame({ state: "stuck", stuck: "failed", lead: "cure", acts: buttons("cure", "tell", "close") }, { ...helper, phase: { _tag: "failed" } });
  expect(aim(f, "bug").aim.ok).toBe(true);
  expect(aim(f, "harvest").aim.ok).toBe(false);
});

test("an issue in a task graph offers no farm actions even while its helper is working", () => {
  const f = frame(
    { state: "working", acts: [] },
    { ...helper, phase: { _tag: "working", since: 0, doing: { action: "none", label: "" } }, graph: { id: "graph" } },
  );
  for (const tool of ["water", "bug", "harvest", "shovel"] as const) expect(aim(f, tool).aim.ok, tool).toBe(false);
  expect(aim(f, "hand").aim.ok).toBe(true);
});

test("watering offers a word only when the issue allows tell", () => {
  expect(aim(frame({ state: "asking", lead: "answer", acts: buttons("answer", "close") }), "water").aim.ok).toBe(false);
  expect(aim(frame({ state: "reviewing", acts: buttons("complete", "tell", "close") }), "water").aim.ok).toBe(true);
});

test("a click is refused when the issue stops allowing its action after aiming", async () => {
  const f = frame({ state: "reviewing", acts: buttons("complete", "tell", "close") });
  farm.hold("harvest");
  const commands = farmCommands(() => f);
  const pointed = commands.aim(beds[0]!);
  f.state.issues[0]!.attention = { state: "asking", acts: buttons("answer", "close") };
  expect((await commands.act(pointed)).kind).toBe("refused");
});
