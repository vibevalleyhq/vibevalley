import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import {
  defaultOrchestrator,
  type Agent,
  type Issue,
  type IssueId,
  type Session,
  type SessionEvent,
  type SessionId,
  type SessionView,
} from "@vibevalley/protocol";

import {
  buildRunEntries,
  filterRunEntries,
  isRecoverableRun,
  parseRunsSearch,
  resolveSelectedRun,
  runActivityAt,
  runsHref,
  runStatusOf,
  runTelemetryOf,
  supportsCodeMode,
  supportsManualCompaction,
} from "./runsView";

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
    toolsets: ["issue", "session", "channel", "resource", "memory", "library", "artifact"],
    mcpServers: [],
    disallowedTools: [],
    env: {},
    workdir: "",
    worktree: role === "worker",
    tags: [],
    look: baseLook,
  };
}

function makeSession(overrides: Omit<Partial<Session>, "id"> & { id: string; name: string }): Session {
  const { id, ...rest } = overrides;
  return {
    controller: "issueBoard",
    role: "worker",
    runtime: "claude",
    brief: "",
    policy: { kind: "sandboxDir" },
    bindings: [],
    hiredAt: 1_000,
    runs: 1,
    phase: { _tag: "resting" },
    ...rest,
    id: sid(id),
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
      controller: "orchestrator",
      role: "orchestrator",
      profile: defaultOrchestrator,
      name: "老村长",
      hiredAt: 2_000,
      phase: { _tag: "working", since: 9_000, doing: { action: "thinking", label: "" } },
    }),
  );

  const activeWorker = makeSession({
    id: "w-active",
    profile: "laozhou",
    name: "老周",
    policy: { kind: "managedWorktree", repo: "vibevalley" },
    bindings: [{ kind: "issue", id: iid("i18") }],
    hiredAt: 5_000,
    phase: { _tag: "working", since: 8_000, doing: { action: "edit_file", label: "app.ts" } },
  });
  const restingWorker = makeSession({
    id: "w-rest",
    profile: "xiaolin",
    name: "小林",
    bindings: [{ kind: "issue", id: iid("i33") }],
    hiredAt: 4_000,
    lastRun: { outcome: "completed", summary: "ok", at: 7_000 },
    phase: { _tag: "resting" },
  });
  const closedWorker = makeSession({
    id: "w-closed",
    profile: "laozhou",
    name: "老周",
    hiredAt: 3_000,
    phase: { _tag: "closed", at: 7_500, closed: "merged" },
  });

  const entries = buildRunEntries({
    orchestrators: [sideOrch, mainOrch],
    sessions: [
      makeSession({ id: "orch-1", controller: "orchestrator", role: "orchestrator", profile: defaultOrchestrator, name: "老村长", hiredAt: 2_000 }),
      closedWorker,
      restingWorker,
      activeWorker,
    ],
    liveSessions: [liveOrchSession, makeLive(activeWorker)],
    issues: [makeIssue("i18", 18, "修复登录过期"), makeIssue("i33", 33, "弹窗确认")],
  });

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
  expect(runActivityAt(entries[0])).toBe(9_000);
  expect(runActivityAt(entries[4])).toBe(7_500);
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
          controller: "orchestrator",
          role: "orchestrator",
          profile: orch.id,
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
        profile: "laozhou",
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
      controller: "orchestrator",
      role: "orchestrator",
      profile: defaultOrchestrator,
      name: "老村长",
      phase: { _tag: "resting" },
    }),
  );
  const w1 = makeSession({
    id: "w1",
    profile: "laozhou",
    name: "老周",
    policy: { kind: "managedWorktree", repo: "vibevalley" },
    bindings: [{ kind: "issue", id: iid("i18") }],
    brief: "登录鉴权修复",
    phase: { _tag: "working", since: 5_000, doing: { action: "run_command", label: "cargo test" } },
  });
  const w2 = makeSession({
    id: "w2",
    profile: "xiaolin",
    name: "小林",
    policy: { kind: "managedWorktree", repo: "site" },
    bindings: [{ kind: "issue", id: iid("i33") }],
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

test("runTelemetryOf folds session telemetry and step events and isRecoverableRun gates worker recovery", () => {
  const withTel = makeSession({
    id: "w-tel",
    name: "老周",
    spent: { tokens: 12_000, cny: 0.25 },
    telemetry: {
      inputTokens: 6_000,
      cacheReadTokens: 4_000,
      outputTokens: 2_000,
      contextUsed: 64_000,
      contextWindow: 128_000,
      llmRetries: 2,
      runErrors: 1,
    },
    phase: { _tag: "failed" },
  });
  const entryWithTel: ReturnType<typeof buildRunEntries>[number] = {
    kind: "worker",
    id: "w-tel",
    session: withTel,
    live: undefined,
    active: false,
  };
  const rollupTel = runTelemetryOf(entryWithTel);
  expect(rollupTel.spent?.tokens).toBe(12_000);
  expect(rollupTel.spent?.cny).toBe(0.25);
  expect(rollupTel.llmRetries).toBe(2);
  expect(rollupTel.runErrors).toBe(1);
  expect(rollupTel.contextUsed).toBe(64_000);
  expect(rollupTel.contextWindow).toBe(128_000);
  expect(rollupTel.contextPct).toBe(50);
  expect(rollupTel.hasContext).toBe(true);
  expect(isRecoverableRun(entryWithTel)).toBe(true);

  const bareSession = makeSession({
    id: "w-steps",
    name: "小林",
    phase: { _tag: "resting" },
  });
  const steps: SessionEvent[] = [
    {
      seq: 1,
      revision: 1,
      run: "r1",
      type: "llm/usage",
      text: "",
      time: 10,
      tokens: { input: 2_000, cacheRead: 1_000, output: 500, contextUsed: 45_000, contextWindow: 100_000 },
    },
    { seq: 2, revision: 1, run: "r1", type: "llm/retry", text: "retrying", time: 11 },
    { seq: 3, revision: 1, run: "r1", type: "run/error", text: "timeout", time: 12 },
  ];
  const entryFromSteps: ReturnType<typeof buildRunEntries>[number] = {
    kind: "worker",
    id: "w-steps",
    session: bareSession,
    live: undefined,
    active: false,
  };
  const rollupSteps = runTelemetryOf(entryFromSteps, steps);
  expect(rollupSteps.spent?.tokens).toBe(3_500);
  expect(rollupSteps.llmRetries).toBe(1);
  expect(rollupSteps.runErrors).toBe(1);
  expect(rollupSteps.contextPct).toBe(45);
  expect(isRecoverableRun(entryFromSteps)).toBe(true);

  expect(
    isRecoverableRun({
      kind: "worker",
      id: "w-int",
      session: makeSession({
        id: "w-int",
        name: "小林",
        phase: { _tag: "resting" },
        lastRun: { outcome: "interrupted", summary: "", at: 12 },
      }),
      live: undefined,
      active: false,
    }),
  ).toBe(true);
  expect(
    isRecoverableRun({
      kind: "worker",
      id: "w-done",
      session: makeSession({ id: "w-done", name: "小林", phase: { _tag: "done" } }),
      live: undefined,
      active: false,
    }),
  ).toBe(false);
  expect(
    isRecoverableRun({
      kind: "worker",
      id: "w-work",
      session: makeSession({ id: "w-work", name: "小林", phase: { _tag: "working", since: 1, doing: { action: "run_command", label: "test" } } }),
      live: undefined,
      active: true,
    }),
  ).toBe(false);
  expect(
    isRecoverableRun({
      kind: "worker",
      id: "w-closed",
      session: makeSession({ id: "w-closed", name: "小林", phase: { _tag: "closed", at: 12, closed: "merged" } }),
      live: undefined,
      active: false,
    }),
  ).toBe(false);
});

test("supportsManualCompaction and supportsCodeMode gate run actions by runtime and phase", () => {
  const orchAgent = makeAgent(defaultOrchestrator, "orchestrator", "Orch");
  const orchIdle: ReturnType<typeof buildRunEntries>[number] = {
    kind: "orchestrator",
    id: defaultOrchestrator,
    agent: orchAgent,
    live: undefined,
    active: false,
  };
  expect(supportsManualCompaction(orchIdle)).toBe(true);
  expect(supportsCodeMode(orchIdle)).toBe(true);

  const orchBusy: ReturnType<typeof buildRunEntries>[number] = {
    kind: "orchestrator",
    id: defaultOrchestrator,
    agent: orchAgent,
    live: undefined,
    active: true,
  };
  expect(supportsManualCompaction(orchBusy)).toBe(false);
  expect(supportsCodeMode(orchBusy)).toBe(true);

  const vvIdle: ReturnType<typeof buildRunEntries>[number] = {
    kind: "worker",
    id: "w-vv",
    session: { ...makeSession({ id: "w-vv", name: "vv", phase: { _tag: "resting" } }), runtime: "vibevalley" },
    live: undefined,
    active: false,
  };
  expect(supportsManualCompaction(vvIdle)).toBe(true);
  expect(supportsCodeMode(vvIdle)).toBe(true);

  const claudeIdle: ReturnType<typeof buildRunEntries>[number] = {
    kind: "worker",
    id: "w-cc",
    session: { ...makeSession({ id: "w-cc", name: "cc", phase: { _tag: "resting" } }), runtime: "claude" },
    live: undefined,
    active: false,
  };
  expect(supportsManualCompaction(claudeIdle)).toBe(true);
  expect(supportsCodeMode(claudeIdle)).toBe(false);

  const opencodeIdle: ReturnType<typeof buildRunEntries>[number] = {
    kind: "worker",
    id: "w-oc",
    session: { ...makeSession({ id: "w-oc", name: "oc", phase: { _tag: "resting" } }), runtime: "opencode" },
    live: undefined,
    active: false,
  };
  expect(supportsManualCompaction(opencodeIdle)).toBe(false);
  expect(supportsCodeMode(opencodeIdle)).toBe(false);

  const vvClosed: ReturnType<typeof buildRunEntries>[number] = {
    kind: "worker",
    id: "w-vv-closed",
    session: { ...makeSession({ id: "w-vv-closed", name: "vv", phase: { _tag: "closed", at: 12, closed: "completed" } }), runtime: "vibevalley" },
    live: undefined,
    active: false,
  };
  expect(supportsManualCompaction(vvClosed)).toBe(false);
  expect(supportsCodeMode(vvClosed)).toBe(false);
});
