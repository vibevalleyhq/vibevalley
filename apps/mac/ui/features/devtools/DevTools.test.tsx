import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type {
  DebugBundleResult,
  DebugGraph,
  DebugOverrideConfig,
  DebugSnapshot,
  DebugTimelineEvent,
  DebugTimelinePage,
  DebugTimelineQuery,
  DebugTrajectoryDetail,
  DebugTrajectorySummary,
} from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import themeJson from "../../design/theme.json";

type App = Awaited<ReturnType<typeof open>>;

function normHex(raw: string): string {
  const hex = raw.trim().toLowerCase().replace(/^#/u, "");
  return hex.length === 6 ? `#${hex}ff` : `#${hex}`;
}

const NOW = 1_764_000_000_000;

const sampleGraph: DebugGraph = {
  clients: [
    {
      id: "client-1",
      kind: "workbench",
      label: "Workbench",
      watches: ["slice:board", "slice:sessions"],
      subscriptions: ["channel.follow"],
    },
  ],
  sessions: [
    {
      sessionId: "sess-1",
      issueId: 42,
      title: "Fix sidebar layout",
      runtime: "codex",
      status: "working",
      worktree: "/work/wt-42",
      kind: "issue_session",
    },
  ],
};

const sampleTimelineEvents: DebugTimelineEvent[] = [
  {
    id: 1,
    time: NOW - 3000,
    lane: "core_apply",
    kind: "issueChanged",
    traceId: 101,
    durationUs: 450,
    summary: "Updated issue #42",
    detail: { seq: 18, issueId: 42, token: "[REDACTED]" },
    slow: false,
  },
  {
    id: 2,
    time: NOW - 2000,
    lane: "bridge_rpc",
    kind: "issue.status.update",
    traceId: 102,
    durationUs: 62_000,
    summary: "Slow bridge RPC call",
    detail: { op: "issue.status.update", redacted: true },
    slow: true,
  },
  {
    id: 3,
    time: NOW - 1000,
    lane: "gpui_frame",
    kind: "Shell::render",
    durationUs: 19_500,
    summary: "GPUI render frame",
    slow: true,
  },
];

const sampleSnapshot: DebugSnapshot = {
  overview: {
    channel: "dev",
    version: "0.9.0-dev",
    loopbackUrl: "http://127.0.0.1:8790",
    homePath: "/Users/test/.vibevalley-dev",
    workRoot: "/Users/test/work",
    dbPath: "/Users/test/.vibevalley-dev/vibevalley.db",
    bundleMode: "nshc",
    bootMs: 145,
    activeSessions: 1,
    activeClients: 2,
    activeSubscriptions: 3,
    latestSeq: 18,
    lastFrameMs: 4.2,
    runtimes: [
      { id: "codex", name: "Codex", installed: true, ready: true, version: "0.52.0" },
      { id: "claude", name: "Claude Code", installed: false, ready: false },
    ],
  },
  routes: {
    current: "/issues",
    nativeWorkspace: true,
    panel: "files",
    inspectorOpen: false,
    projects: [
      {
        id: 1,
        name: "vibevalley",
        path: "/work/vibevalley",
        active: true,
        branch: "feat/devtools-v1",
        tabs: [
          { id: 10, title: "DevToolsApp.tsx", kind: "file", active: true },
          { id: 11, title: "zsh", kind: "terminal", active: false, running: true, runningState: "working" },
        ],
      },
    ],
  },
  overrides: {
    rpcDelayMs: 0,
    sliceDelayMs: 0,
  },
  graph: sampleGraph,
  stateCache: {
    seq: 18,
    sliceSeqs: { board: 18, sessions: 17, collab: 12, inbox: 9, ops: 5, farm: 18 },
    sliceWatchers: { board: 2, sessions: 2, collab: 1, inbox: 1, ops: 0, farm: 1 },
    counts: {
      issues: 14,
      sessions: 3,
      channels: 2,
      agents: 4,
      repos: 2,
      artifacts: 5,
      inbox: 1,
      mediaJobs: 0,
    },
    caches: [{ name: "panes", entries: 3, detail: "2 file, 1 terminal" }],
  },
  recentTimeline: sampleTimelineEvents,
};

const sampleIssueTrajectory: DebugTrajectorySummary = {
  id: "sess-1",
  kind: "issue_session",
  title: "Fix sidebar layout",
  runtime: "codex",
  status: "working",
  updatedAt: NOW - 500,
  eventCount: 2,
  hasVoyageRecord: true,
  hasSilentError: true,
  tokens: { input: 1200, cacheRead: 800, cacheWrite: 150, reasoning: 300, output: 450, contextUsed: 2900, contextWindow: 10000 },
};

const sampleTrajectories: DebugTrajectorySummary[] = [
  sampleIssueTrajectory,
  {
    id: "chat-2",
    kind: "workspace_chat",
    title: "Quick grep",
    runtime: "claude",
    status: "resting",
    updatedAt: NOW - 5000,
    eventCount: 1,
    hasVoyageRecord: false,
    hasSilentError: false,
  },
  {
    id: "orch-main",
    kind: "orchestrator",
    title: "Main Assistant",
    runtime: "deepseek",
    status: "done",
    updatedAt: NOW - 9000,
    eventCount: 1,
    hasVoyageRecord: false,
    hasSilentError: false,
  },
];

const sampleTrajectoryDetail: DebugTrajectoryDetail = {
  summary: sampleIssueTrajectory,
  systemPrompt: "You are a helpful coding assistant. [REDACTED]",
  subagentPaths: ["root/worker-a", "root/worker-b"],
  voyageRecordCount: 4,
  turns: [
    {
      index: 1,
      prompt: "Inspect the DevTools layout tokens",
      startedAt: NOW - 4000,
      endedAt: NOW - 1500,
      durationMs: 2500,
      tokens: { input: 1200, cacheRead: 800, cacheWrite: 150, reasoning: 300, output: 450, contextUsed: 2900, contextWindow: 10000 },
      silentErrors: ["QUOTA_EXHAUSTED on fallback model"],
      events: [
        { seq: 1, revision: 1, time: NOW - 3500, type: "tool/call", tool: "read_file", text: "Reading theme.json", ok: true },
        { seq: 2, revision: 1, time: NOW - 2000, type: "assistant/message", text: "Updated styles using tokens" },
      ],
      rawEntries: [
        {
          seq: 10,
          time: NOW - 3400,
          kind: "oar.frame",
          frameType: "tool_use",
          agentPath: ["root", "worker-a"],
          traceId: 777,
          summary: "raw tool call payload",
          payload: '{"type":"tool_use","name":"read_file","secret":"[REDACTED]"}',
          originalBytes: 8192,
          truncated: true,
        },
      ],
    },
  ],
};

const sampleBundleResult: DebugBundleResult = {
  path: "/Users/test/.vibevalley-dev/debug-bundles/debug-bundle-1764000000.zip",
  sizeBytes: 12_288,
  files: ["overview.json", "routes.json", "timeline.json", "trajectories.json"],
  redactedCount: 7,
};

function createDevToolsHost(params: Record<string, unknown> = {}, initialResponses: Record<string, unknown> = {}, deferOps: readonly string[] = []) {
  const queue: [string, unknown][] = [];
  const heldReplies: [string, unknown][] = [];
  const calls: { op: string; payload: unknown }[] = [];
  const responses: Record<string, unknown> = { ...initialResponses };
  let rev = 0;

  const action = (data: unknown) => {
    const a = data as { type: string; id?: string; op?: string; payload?: unknown };
    if (a.type === "call") {
      const op = a.op ?? "";
      calls.push({ op, payload: a.payload });
      let reply: [string, unknown];
      if (!(op in responses)) {
        reply = [`reply:${a.id}`, { bizCode: BizCode.RouteNotFound, message: `unmocked ${op}` }];
      } else {
        const answer = responses[op];
        const value = typeof answer === "function" ? (answer as (p: unknown) => unknown)(a.payload) : answer;
        const env = value !== null && typeof value === "object" && "bizCode" in value ? value : { bizCode: 0, message: "ok", data: value };
        reply = [`reply:${a.id}`, env];
      }
      if (deferOps.includes(op)) heldReplies.push(reply);
      else queue.push(reply);
    }
    return null;
  };

  const pump = async (app: App) => {
    for (let round = 0; round < 50 && queue.length > 0; round++) {
      for (const [name, data] of queue.splice(0)) await app.host.send(name, data);
    }
  };

  const releaseDeferred = async (app: App) => {
    queue.push(...heldReplies.splice(0));
    await pump(app);
  };

  const pumpUntil = async (app: App, done: () => boolean, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    await pump(app);
    while (!done()) {
      if (queue.length > 0) {
        await pump(app);
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) break;
      await app.waitUntil(() => queue.length > 0 || done(), { timeout: left });
    }
    await pump(app);
  };

  const pushFrame = async (app: App, topic: string, data: unknown) => {
    await app.host.send(`frame:${topic}`, { rev: ++rev, data });
    await pump(app);
  };

  return {
    options: { params: { view: "devtools", locale: "en", detached: false, ...params }, handlers: { action, ready: null } },
    calls,
    clearCalls: () => {
      calls.length = 0;
    },
    pump,
    pumpUntil,
    releaseDeferred,
    pushFrame,
  };
}

test("DevTools renders all 6 tabs, filters timeline, inspects trajectory, applies overrides, and exports bundle", async () => {
  setLocale("en");
  let timelineEvents = [...sampleTimelineEvents];
  let overrides: DebugOverrideConfig = { rpcDelayMs: 0, sliceDelayMs: 0 };

  const host = createDevToolsHost(
    { detached: false },
    {
      "debug.snapshot": () => ({ ...sampleSnapshot, overrides, recentTimeline: timelineEvents }),
      "debug.graph": () => sampleGraph,
      "debug.timeline.list": (payload: unknown): DebugTimelinePage => {
        const q = (payload ?? {}) as DebugTimelineQuery;
        const filtered = timelineEvents.filter((ev) => {
          if (q.lane !== undefined && ev.lane !== q.lane) return false;
          if (q.search && !`${ev.kind} ${ev.summary}`.toLowerCase().includes(q.search.toLowerCase())) return false;
          return true;
        });
        return { events: filtered, latestId: 3, dropped: 5 };
      },
      "debug.timeline.clear": () => {
        timelineEvents = [];
        return { bizCode: 0, message: "ok" };
      },
      "debug.trajectory.list": () => sampleTrajectories,
      "debug.trajectory.get": () => sampleTrajectoryDetail,
      "debug.override.set": (payload: unknown) => {
        overrides = payload as DebugOverrideConfig;
        return overrides;
      },
      "debug.bundle.export": () => sampleBundleResult,
    },
  );

  const app = await open("../../ShellApp.story.tsx", {
    width: 1100,
    height: 760,
    colorScheme: "light",
    platform: "macos",
    clock: { time: NOW },
    host: host.options,
  });
  await host.pumpUntil(app, () => app.count("id:devtools-overview") === 1);

  expect(app.viewStyle("id:devtools-root")?.backgroundColor).toBe(normHex(themeJson.cssVars.light.page));
  expect(app.viewStyle("id:devtools-topbar")?.backgroundColor).toBe(normHex(themeJson.cssVars.light.side));
  expect(app.viewStyle("id:devtools-rail")?.backgroundColor).toBe(normHex(themeJson.cssVars.light.rail));
  await app.setColorScheme("dark");
  expect(app.viewStyle("id:devtools-root")?.backgroundColor).toBe(normHex(themeJson.cssVars.dark.page));
  expect(app.viewStyle("id:devtools-topbar")?.backgroundColor).toBe(normHex(themeJson.cssVars.dark.side));
  expect(app.viewStyle("id:devtools-rail")?.backgroundColor).toBe(normHex(themeJson.cssVars.dark.rail));
  await app.setColorScheme("light");

  expect(app.texts()).toContain(t("web.devtools.title"));
  expect(app.texts()).toContain("0.9.0-dev");
  expect(app.texts()).toContain("http://127.0.0.1:8790");
  expect(app.texts()).toContain("Codex");
  expect(app.texts()).toContain("Workbench");
  expect(app.texts()).toContain("Fix sidebar layout");

  const acts = (app: App) =>
    app.host
      .posts()
      .filter((p) => p.name === "action")
      .map((p) => p.data);

  await app.press("id:devtools-detach");
  expect(acts(app)).toContainEqual({ type: "detach_devtools" });
  await app.press("id:devtools-close");
  expect(acts(app)).toContainEqual({ type: "close_devtools" });

  await app.press("id:devtools-tab-routes");
  expect(app.count("id:devtools-routes")).toBe(1);
  expect(app.texts()).toContain("/issues");
  expect(app.texts()).toContain("DevToolsApp.tsx");
  await app.type("id:routes-search", "settings");
  expect(app.count("id:route-jump-settings")).toBe(1);
  expect(app.count("id:route-jump-issues")).toBe(0);
  await app.press("id:route-jump-settings");
  expect(acts(app)).toContainEqual({ type: "open_route", path: "/settings" });

  await app.press("id:devtools-tab-timeline");
  await host.pumpUntil(app, () => app.texts().includes(t("web.devtools.timeline.dropped", { count: 5 })));
  expect(app.count("id:timeline-row-2")).toBe(1);

  await app.press("id:timeline-slow-only");
  expect(app.count("id:timeline-row-1")).toBe(0);
  expect(app.count("id:timeline-row-2")).toBe(1);
  expect(app.count("id:timeline-row-3")).toBe(1);
  await app.press("id:timeline-slow-only");
  expect(app.count("id:timeline-row-1")).toBe(1);

  await app.press("id:timeline-lane-bridge_rpc");
  await host.pumpUntil(
    app,
    () =>
      app.count("id:timeline-row-1") === 0 &&
      host.calls.some((c) => c.op === "debug.timeline.list" && (c.payload as DebugTimelineQuery | undefined)?.lane === "bridge_rpc"),
  );
  expect(app.count("id:timeline-row-2")).toBe(1);

  await app.press("id:timeline-row-2");
  expect(app.count("id:timeline-detail-2")).toBe(1);
  expect(app.texts().some((s) => s.includes('"issue.status.update"'))).toBe(true);

  await app.press("id:timeline-clear");
  await host.pumpUntil(app, () => app.count("id:timeline-empty") === 1);
  expect(host.calls.some((c) => c.op === "debug.timeline.clear")).toBe(true);

  await app.press("id:devtools-tab-trajectory");
  await host.pumpUntil(app, () => app.count("id:trajectory-item-sess-1") === 1);
  expect(app.texts()).toContain("Quick grep");
  expect(app.texts()).toContain("Main Assistant");

  await app.press("id:trajectory-item-sess-1");
  await host.pumpUntil(app, () => app.count("id:trajectory-turn-1") === 1);
  expect(host.calls.some((c) => c.op === "debug.trajectory.get")).toBe(true);
  expect(app.texts()).toContain("QUOTA_EXHAUSTED on fallback model");
  expect(app.texts()).toContain("in:1200");
  expect(app.texts()).toContain("cacheR:800");
  expect(app.texts()).toContain("cacheW:150");
  expect(app.texts()).toContain("reason:300");
  expect(app.texts()).toContain("out:450");
  expect(app.texts()).toContain("ctx:29%");
  expect(app.texts()).toContain("root/worker-a");
  expect(app.texts()).toContain(t("web.devtools.trajectory.truncated", { bytes: 8192 }));

  await app.press("id:trajectory-system-prompt-toggle");
  expect(app.count("id:trajectory-system-prompt-body")).toBe(1);

  await app.press("id:trajectory-raw-1-10");
  expect(app.count("id:trajectory-raw-payload-1-10")).toBe(1);
  await app.press("id:trajectory-raw-copy-1-10");
  expect(app.clipboard()).toContain('"tool_use"');

  await app.press("id:devtools-tab-state");
  expect(app.count("id:devtools-state")).toBe(1);
  expect(app.count("id:state-slice-board")).toBe(1);
  expect(app.count("id:state-slice-sessions")).toBe(1);
  expect(app.count("id:state-slice-collab")).toBe(1);
  expect(app.count("id:state-slice-inbox")).toBe(1);
  expect(app.count("id:state-slice-ops")).toBe(1);
  expect(app.count("id:state-slice-farm")).toBe(1);
  await app.press("id:state-slice-farm");
  expect(app.texts().some((s) => s.includes('"slice": "farm"'))).toBe(true);

  await app.press("id:devtools-tab-lab");
  expect(app.count("id:devtools-lab")).toBe(1);
  expect(app.texts()).toContain(t("web.devtools.lab.warning"));

  host.clearCalls();
  await app.press("id:lab-rpc-delay-300");
  await host.pumpUntil(app, () => app.count("id:lab-feedback") === 1);
  const overrideCall = host.calls.find((c) => c.op === "debug.override.set");
  expect(overrideCall?.payload).toEqual({ rpcDelayMs: 300, sliceDelayMs: 0 });
  expect(app.texts()).toContain(t("web.devtools.lab.applied"));

  await app.press("id:lab-export-bundle");
  await host.pumpUntil(app, () => app.count("id:lab-bundle-result") === 1);
  expect(host.calls.some((c) => c.op === "debug.bundle.export")).toBe(true);
  expect(app.texts()).toContain(t("web.devtools.overview.bundleExported", { path: sampleBundleResult.path, redacted: sampleBundleResult.redactedCount }));
  await app.press("id:lab-bundle-copy");
  expect(app.clipboard()).toBe(sampleBundleResult.path);

  host.clearCalls();
  await app.press("id:lab-reset");
  await host.pumpUntil(app, () => app.texts().includes(t("web.devtools.lab.resetDone")));
  expect(host.calls.find((c) => c.op === "debug.override.set")?.payload).toEqual({ rpcDelayMs: 0, sliceDelayMs: 0 });
});

test("DevTools auto-refresh polls on interval and pauses cleanly", async () => {
  setLocale("en");
  const host = createDevToolsHost(
    { detached: false },
    {
      "debug.snapshot": () => sampleSnapshot,
      "debug.graph": () => sampleGraph,
    },
  );

  const app = await open("../../ShellApp.story.tsx", {
    width: 960,
    height: 640,
    colorScheme: "light",
    platform: "macos",
    clock: { time: NOW },
    host: host.options,
  });
  const clock = app.clock;
  if (!clock) throw new Error("virtual clock required");

  await host.pumpUntil(app, () => app.count("id:devtools-overview") === 1);
  const initialCalls = host.calls.filter((c) => c.op === "debug.snapshot").length;
  expect(initialCalls).toBe(1);

  await clock.fastForward(2_100);
  await host.pumpUntil(app, () => host.calls.filter((c) => c.op === "debug.snapshot").length === 2);
  expect(host.calls.filter((c) => c.op === "debug.snapshot").length).toBe(2);

  await app.press("id:devtools-auto-refresh");
  expect(app.texts()).toContain(t("web.devtools.actions.resume"));
  await clock.fastForward(4_500);
  await host.pump(app);
  expect(host.calls.filter((c) => c.op === "debug.snapshot").length).toBe(2);
});

test("DevTools hides detach button when detached and shows disabled refusal state", async () => {
  setLocale("en");
  const host = createDevToolsHost(
    { detached: true },
    {
      "debug.snapshot": { bizCode: BizCode.Forbidden, message: "DevTools are disabled on the server." },
    },
  );

  const app = await open("../../ShellApp.story.tsx", {
    width: 960,
    height: 640,
    colorScheme: "dark",
    platform: "macos",
    clock: { time: NOW },
    host: host.options,
  });
  await host.pumpUntil(app, () => app.count("id:devtools-disabled") === 1);

  expect(app.count("id:devtools-detach")).toBe(0);
  expect(app.count("id:devtools-disabled")).toBe(1);
  expect(app.texts()).toContain(t("web.devtools.status.disabled"));
});

test("regression: auto-refresh preserves tab state without remounting, timeline searches locally with limit 60, and devtools_visible pauses/resumes polling", async () => {
  setLocale("en");
  let seq = 18;
  const host = createDevToolsHost(
    { detached: false },
    {
      "debug.snapshot": (): DebugSnapshot => ({
        ...sampleSnapshot,
        overview: { ...sampleSnapshot.overview, latestSeq: seq },
        stateCache: { ...sampleSnapshot.stateCache, seq },
      }),
      "debug.timeline.list": (payload: unknown): DebugTimelinePage => {
        const q = (payload ?? {}) as DebugTimelineQuery;
        const filtered = sampleTimelineEvents.filter((ev) => q.lane === undefined || ev.lane === q.lane);
        return { events: filtered, latestId: 3, dropped: 0 };
      },
    },
  );

  const app = await open("../../ShellApp.story.tsx", {
    width: 1100,
    height: 760,
    colorScheme: "light",
    platform: "macos",
    clock: { time: NOW },
    host: host.options,
  });
  const clock = app.clock;
  if (!clock) throw new Error("virtual clock required");

  const snapshotCalls = () => host.calls.filter((c) => c.op === "debug.snapshot").length;
  const timelineCalls = () => host.calls.filter((c) => c.op === "debug.timeline.list");

  await host.pumpUntil(app, () => app.count("id:devtools-overview") === 1);
  expect(snapshotCalls()).toBe(1);
  expect(app.texts()).toContain("seq 18");

  await app.press("id:devtools-tab-timeline");
  await host.pumpUntil(app, () => timelineCalls().length === 1 && app.count("id:timeline-row-2") === 1);
  expect((timelineCalls()[0]?.payload as DebugTimelineQuery | undefined)?.limit).toBe(60);

  await app.press("id:timeline-row-2");
  expect(app.count("id:timeline-detail-2")).toBe(1);

  const timelineCallsBeforeSearch = timelineCalls().length;
  await app.type("id:timeline-search", "bridge");
  expect(app.count("id:timeline-row-2")).toBe(1);
  expect(app.count("id:timeline-row-1")).toBe(0);
  expect(timelineCalls().length).toBe(timelineCallsBeforeSearch);

  seq = 19;
  await clock.fastForward(2_100);
  await host.pumpUntil(app, () => snapshotCalls() === 2 && app.texts().includes("seq 19"));
  expect(app.count("id:timeline-detail-2")).toBe(1);
  expect(app.count("id:timeline-row-1")).toBe(0);

  await app.press("id:devtools-tab-state");
  expect(app.count("id:devtools-state")).toBe(1);
  await app.press("id:state-slice-farm");
  expect(app.texts().some((s) => s.includes('"slice": "farm"') && s.includes('"globalSeq": 19'))).toBe(true);

  seq = 20;
  await clock.fastForward(2_100);
  await host.pumpUntil(app, () => snapshotCalls() === 3 && app.texts().includes("seq 20"));
  expect(app.texts().some((s) => s.includes('"slice": "farm"') && s.includes('"globalSeq": 20'))).toBe(true);

  const callsBeforeHide = snapshotCalls();
  await host.pushFrame(app, "devtools_visible", { visible: false });
  await clock.fastForward(6_500);
  await host.pump(app);
  expect(snapshotCalls()).toBe(callsBeforeHide);

  seq = 21;
  await host.pushFrame(app, "devtools_visible", { visible: true });
  await host.pumpUntil(app, () => snapshotCalls() === callsBeforeHide + 1 && app.texts().includes("seq 21"));
  expect(app.texts().some((s) => s.includes('"slice": "farm"') && s.includes('"globalSeq": 21'))).toBe(true);

  seq = 22;
  await clock.fastForward(2_100);
  await host.pumpUntil(app, () => snapshotCalls() === callsBeforeHide + 2 && app.texts().includes("seq 22"));
});

test("regression: timeline and trajectory tabs do not overlap duplicate in-flight fetches on refresh", async () => {
  setLocale("en");
  const host = createDevToolsHost(
    { detached: false },
    {
      "debug.snapshot": () => sampleSnapshot,
      "debug.timeline.list": (): DebugTimelinePage => ({ events: sampleTimelineEvents, latestId: 3, dropped: 0 }),
      "debug.trajectory.list": () => sampleTrajectories,
    },
    ["debug.timeline.list", "debug.trajectory.list"],
  );

  const app = await open("../../ShellApp.story.tsx", {
    width: 1100,
    height: 760,
    colorScheme: "light",
    platform: "macos",
    clock: { time: NOW },
    host: host.options,
  });
  const clock = app.clock;
  if (!clock) throw new Error("virtual clock required");

  const countOp = (op: string) => host.calls.filter((c) => c.op === op).length;

  await host.pumpUntil(app, () => app.count("id:devtools-overview") === 1);

  await app.press("id:devtools-tab-timeline");
  await host.pumpUntil(app, () => countOp("debug.timeline.list") === 1);

  await clock.fastForward(2_100);
  await host.pumpUntil(app, () => countOp("debug.snapshot") === 2);
  expect(countOp("debug.timeline.list")).toBe(1);

  await host.releaseDeferred(app);
  await clock.fastForward(2_100);
  await host.pumpUntil(app, () => countOp("debug.snapshot") === 3 && countOp("debug.timeline.list") === 2);
  await host.releaseDeferred(app);

  await app.press("id:devtools-tab-trajectory");
  await host.pumpUntil(app, () => countOp("debug.trajectory.list") === 1);

  await clock.fastForward(2_100);
  await host.pumpUntil(app, () => countOp("debug.snapshot") === 4);
  expect(countOp("debug.trajectory.list")).toBe(1);

  await host.releaseDeferred(app);
  await host.pumpUntil(app, () => app.count("id:trajectory-item-sess-1") === 1);
});
