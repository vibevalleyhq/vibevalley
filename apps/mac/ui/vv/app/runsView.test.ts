import "../polyfill";
import { expect, test } from "nsh/test";

import { defaultOrchestrator, type Agent, type Issue, type IssueId, type Session, type SessionId, type SessionView } from "@vibevalley/protocol";

import { buildRunEntries, filterRunEntries, parseRunsSearch, resolveSelectedRun, runActivityAt, runsHref, runStatusOf } from "../web/features/session/runsView";

const sid = (id: string) => id as SessionId;
const iid = (id: string) => id as IssueId;

const baseLook: Agent["look"] = {
  species: null,
  outfit: null,
  orchestrator: "farmer",
  build: "biped",
  head: "rounded",
  body: "",
  trim: "",
  hat: "",
  eye: "",
};

function makeAgent(id: string, role: Agent["role"], name: string, duty = ""): Agent {
  return {
    id,
    name,
    role,
    duty,
    enabled: true,
    runtime: role === "orchestrator" ? "vibevalley" : "claude",
    model: "",
    effort: "",
    persona: "",
    personaMode: "append",
    skills: [],
    mcpServers: [],
    disallowedTools: [],
    env: {},
    workdir: "",
    worktree: role === "worker",
    tags: [],
    look: baseLook,
  };
}

function makeSession(overrides: Omit<Partial<Session>, "id" | "issue"> & { id: string; agent: string; name: string; issue?: string }): Session {
  const { id, issue, ...rest } = overrides;
  return {
    role: "worker",
    runtime: "claude",
    brief: "",
    hiredAt: 1_000,
    runs: 1,
    refining: false,
    phase: { _tag: "resting" },
    ...rest,
    id: sid(id),
    ...(issue !== undefined ? { issue: iid(issue) } : {}),
  };
}

function makeLive(session: Session, phaseText = ""): SessionView {
  const phase: SessionView["phase"] =
    session.phase._tag === "working" ? { ...session.phase, doing: { ...session.phase.doing, actionText: "正在改代码" } } : session.phase;
  return { ...session, phase, phaseText };
}

function makeIssue(id: string, number: number, title: string): Issue {
  return {
    id: iid(id),
    number,
    title,
    description: "",
    mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
    status: "in_progress",
    moves: [],
    priority: "medium",
    deliver: "change",
    repo: "vibevalley",
    criteria: [],
    checks: [],
    questions: [],
    findings: [],
    assignments: [],
    blockedBy: [],
    createdAt: 1_000,
    stage: { state: "working", acts: [] },
  };
}

test("runsHref and parseRunsSearch round-trip and normalize invalid scopes", () => {
  expect(runsHref()).toBe("/runs");
  expect(runsHref({ scope: "all" })).toBe("/runs");
  expect(runsHref({ session: "w1", issue: "i18" })).toBe("/runs?session=w1&issue=i18");
  expect(runsHref({ agent: "laozhou", scope: "worker" })).toBe("/runs?scope=worker&agent=laozhou");

  expect(parseRunsSearch("")).toEqual({});
  expect(parseRunsSearch("?session=w1&scope=active&agent=laozhou&issue=i18")).toEqual({
    session: "w1",
    scope: "active",
    agent: "laozhou",
    issue: "i18",
  });
  expect(parseRunsSearch("?scope=bogus&session=%20%20")).toEqual({});
  expect(parseRunsSearch(new URLSearchParams("scope=orchestrator&session=orchestrator"))).toEqual({
    scope: "orchestrator",
    session: "orchestrator",
  });
});

test("buildRunEntries deduplicates orchestrator sessions, sorts active runs first, and groups orchestrators cleanly", () => {
  const mainOrch = makeAgent(defaultOrchestrator, "orchestrator", "老村长", "派活与协调");
  const sideOrch = makeAgent("ops-orch", "orchestrator", "值班助手", "盯巡查");

  const liveOrchSession = makeLive(
    makeSession({
      id: "orch-1",
      role: "orchestrator",
      agent: defaultOrchestrator,
      name: "老村长",
      hiredAt: 2_000,
      phase: { _tag: "working", since: 9_000, doing: { action: "thinking", label: "" } },
    }),
  );

  const activeWorker = makeSession({
    id: "w-active",
    agent: "laozhou",
    name: "老周",
    issue: "i18",
    repo: "vibevalley",
    hiredAt: 5_000,
    phase: { _tag: "working", since: 8_000, doing: { action: "edit_file", label: "app.ts" } },
  });
  const restingWorker = makeSession({
    id: "w-rest",
    agent: "xiaolin",
    name: "小林",
    issue: "i33",
    hiredAt: 4_000,
    lastRun: { outcome: "completed", summary: "ok", at: 7_000 },
    phase: { _tag: "resting" },
  });
  const closedWorker = makeSession({
    id: "w-closed",
    agent: "laozhou",
    name: "老周",
    hiredAt: 3_000,
    phase: { _tag: "closed", at: 7_500, closed: "merged" },
  });

  const entries = buildRunEntries({
    orchestrators: [sideOrch, mainOrch],
    sessions: [
      makeSession({ id: "orch-1", role: "orchestrator", agent: defaultOrchestrator, name: "老村长", hiredAt: 2_000 }),
      closedWorker,
      restingWorker,
      activeWorker,
    ],
    liveSessions: [liveOrchSession, makeLive(activeWorker)],
    issues: [makeIssue("i18", 18, "修复登录过期"), makeIssue("i33", 33, "弹窗确认")],
  });

  // orch-1 must NOT duplicate as a worker entry.
  expect(entries.map((e) => `${e.kind}:${e.id}`)).toEqual([
    `orchestrator:${defaultOrchestrator}`,
    "worker:w-active",
    "orchestrator:ops-orch",
    "worker:w-rest",
    "worker:w-closed",
  ]);

  expect(entries[0]?.active).toBe(true);
  expect(entries[1]?.active).toBe(true);
  expect(entries[2]?.active).toBe(false);
  expect(runActivityAt(entries[0]!)).toBe(9_000);
  expect(runActivityAt(entries[4]!)).toBe(7_500);
  expect(entries[1]?.kind === "worker" ? entries[1].issue?.number : undefined).toBe(18);
});

test("runStatusOf maps every RunEntry phase and outcome deterministically", () => {
  const orch = makeAgent(defaultOrchestrator, "orchestrator", "老村长");
  expect(runStatusOf({ kind: "orchestrator", id: orch.id, agent: orch, active: false })).toBe("listening");
  expect(
    runStatusOf({
      kind: "orchestrator",
      id: orch.id,
      agent: orch,
      live: makeLive(
        makeSession({
          id: "orch-1",
          role: "orchestrator",
          agent: orch.id,
          name: orch.name,
          phase: { _tag: "working", since: 100, doing: { action: "thinking", label: "" } },
        }),
      ),
      active: true,
    }),
  ).toBe("working");

  const workerWith = (phase: Session["phase"], outcome?: "completed" | "failed" | "interrupted") =>
    runStatusOf({
      kind: "worker",
      id: "w",
      session: makeSession({
        id: "w",
        agent: "laozhou",
        name: "老周",
        phase,
        ...(outcome ? { lastRun: { outcome, summary: "", at: 10 } } : {}),
      }),
      active: phase._tag === "working",
    });

  expect(workerWith({ _tag: "working", since: 10, doing: { action: "edit_file", label: "" } })).toBe("working");
  expect(workerWith({ _tag: "resting" })).toBe("resting");
  expect(workerWith({ _tag: "resting" }, "interrupted")).toBe("interrupted");
  expect(workerWith({ _tag: "done" }, "completed")).toBe("done");
  expect(workerWith({ _tag: "done" }, "interrupted")).toBe("interrupted");
  expect(workerWith({ _tag: "failed" }, "failed")).toBe("failed");
  expect(workerWith({ _tag: "closed", at: 20, closed: "merged" })).toBe("closed");
});

test("filterRunEntries and resolveSelectedRun handle scope, agentId, issueId, query, and orchestrator live session id", () => {
  const orch = makeAgent(defaultOrchestrator, "orchestrator", "老村长", "派活与协调");
  const liveOrch = makeLive(
    makeSession({
      id: "orch-live",
      role: "orchestrator",
      agent: defaultOrchestrator,
      name: "老村长",
      phase: { _tag: "resting" },
    }),
  );
  const w1 = makeSession({
    id: "w1",
    agent: "laozhou",
    name: "老周",
    issue: "i18",
    repo: "vibevalley",
    brief: "登录鉴权修复",
    phase: { _tag: "working", since: 5_000, doing: { action: "run_command", label: "cargo test" } },
  });
  const w2 = makeSession({
    id: "w2",
    agent: "xiaolin",
    name: "小林",
    issue: "i33",
    repo: "site",
    brief: "调整暗色样式",
    phase: { _tag: "done" },
  });

  const entries = buildRunEntries({
    orchestrators: [orch],
    sessions: [w1, w2],
    liveSessions: [liveOrch, makeLive(w1)],
    issues: [makeIssue("i18", 18, "修复登录过期"), makeIssue("i33", 33, "暗色模式按钮")],
  });

  expect(filterRunEntries(entries, { scope: "active" }).map((e) => e.id)).toEqual(["w1"]);
  expect(filterRunEntries(entries, { scope: "orchestrator" }).map((e) => e.id)).toEqual([defaultOrchestrator]);
  expect(filterRunEntries(entries, { scope: "worker" }).map((e) => e.id)).toEqual(["w1", "w2"]);
  expect(filterRunEntries(entries, { scope: "all", agentId: "xiaolin" }).map((e) => e.id)).toEqual(["w2"]);
  expect(filterRunEntries(entries, { scope: "all", agentId: defaultOrchestrator }).map((e) => e.id)).toEqual([defaultOrchestrator]);
  expect(filterRunEntries(entries, { scope: "all", issueId: "i18" }).map((e) => e.id)).toEqual(["w1"]);
  expect(filterRunEntries(entries, { scope: "all", query: "#33" }).map((e) => e.id)).toEqual(["w2"]);
  expect(filterRunEntries(entries, { scope: "all", query: "协调" }).map((e) => e.id)).toEqual([defaultOrchestrator]);
  expect(filterRunEntries(entries, { scope: "all", query: "no-such-run" })).toEqual([]);

  expect(resolveSelectedRun(entries, "w2")?.id).toBe("w2");
  expect(resolveSelectedRun(entries, "orch-live")?.id).toBe(defaultOrchestrator);
  expect(resolveSelectedRun(entries, "missing")?.id).toBe("w1");
  expect(resolveSelectedRun([], "w1")).toBeUndefined();
});
