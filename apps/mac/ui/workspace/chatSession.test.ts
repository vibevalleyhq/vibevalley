import "../infra/polyfill";
import { expect, test } from "nsh/test";

import type { RuntimeInfo, SessionEvent } from "@vibevalley/protocol";

import { setTransport, transport } from "../infra/transport";
import {
  asThoughtLevel,
  clampThoughtLevel,
  computeTelemetry,
  defaultThoughtLevelFor,
  extractToolTarget,
  fetchWorkspaceRuntimes,
  formatDurationMs,
  formatTokens,
  formatToolDetails,
  groupChatSteps,
  latestSessionTodos,
  mergeChatSteps,
  parseBoardTokens,
  parseTodoChecklist,
  preferredModelFor,
  setWorkspaceConfig,
  thinkingPreview,
  toWorkspaceRuntime,
  visibleChatSteps,
  watchWorkspaceSession,
} from "./chatSession";

const step = (seq: number, type: SessionEvent["type"], more: Partial<SessionEvent> = {}): SessionEvent => ({
  seq,
  revision: 1,
  time: 1_700_000_000_000 + seq * 1_000,
  type,
  text: "",
  ...more,
});

test("extractToolTarget parses JSON path, line number, and edit diff capability", () => {
  expect(
    extractToolTarget(
      step(1, "tool/call", {
        action: "read_file",
        tool: "read_file",
        input: JSON.stringify({ file_path: "crates/runtime/src/oar/acp/mod.rs", start_line: 136 }),
      }),
    ),
  ).toEqual({ path: "crates/runtime/src/oar/acp/mod.rs", line: 136, canDiff: false });

  expect(
    extractToolTarget(
      step(2, "tool/call", {
        action: "edit_file",
        tool: "replace_file_content",
        input: JSON.stringify({ TargetFile: "apps/mac/src/panes.rs", StartLine: 42 }),
      }),
    ),
  ).toEqual({ path: "apps/mac/src/panes.rs", line: 42, canDiff: true });

  expect(
    extractToolTarget(
      step(3, "tool/call", {
        action: "read_file",
        text: "apps/mac/ui/workspace/ChatPane.tsx:88",
      }),
    ),
  ).toEqual({ path: "apps/mac/ui/workspace/ChatPane.tsx", line: 88, canDiff: false });

  expect(extractToolTarget(step(4, "tool/call", { action: "run_command", input: JSON.stringify({ command: "cargo test" }) }))).toBeUndefined();
});

test("computeTelemetry calculates cached vs uncached context %, cache hit %, turns, and tools", () => {
  const events: SessionEvent[] = [
    step(1, "user/message", { text: "Upgrade ACP" }),
    step(2, "tool/call", { action: "read_file", text: "acp.rs" }),
    step(3, "tool/result", { call: 2, ok: true, output: "ok" }),
    step(4, "llm/usage", {
      tokens: {
        input: 76_000,
        cacheRead: 62_400,
        output: 6_800,
        reasoning: 2_100,
        contextUsed: 76_000,
        contextWindow: 200_000,
      },
    }),
  ];

  const tel = computeTelemetry(events);
  expect(tel.hasData).toBe(true);
  expect(tel.turns).toBe(1);
  expect(tel.toolCount).toBe(1);
  expect(tel.cachedRead).toBe(62_400);
  expect(tel.uncachedInput).toBe(13_600);
  expect(tel.output).toBe(6_800);
  expect(tel.reasoning).toBe(2_100);
  expect(tel.contextPct).toBe(38);
  expect(tel.cacheHitPct).toBe(82);
  expect(formatTokens(62_400)).toBe("62.4k");
  expect(formatTokens(1_000_000)).toBe("1M");
});

test("mergeChatSteps and visibleChatSteps fold tool results into calls and keep highest revision", () => {
  const initial = [step(1, "assistant/message", { revision: 1, text: "Hel" }), step(2, "tool/call", { tool: "read_file", text: "a.rs" })];
  const merged = mergeChatSteps(initial, [
    step(1, "assistant/message", { revision: 2, text: "Hello world" }),
    step(3, "tool/result", { call: 2, ok: true, output: "file body" }),
    step(4, "llm/usage", { tokens: { input: 100, cacheRead: 50, output: 20 } }),
  ]);
  const visible = visibleChatSteps(merged);
  expect(visible.length).toBe(2);
  expect(visible[0]?.text).toBe("Hello world");
  expect(visible[1]?.output).toBe("file body");
  expect(visible[1]?.ok).toBe(true);
});

test("asThoughtLevel preserves live agy efforts including xhigh and minimal", () => {
  expect(asThoughtLevel("minimal")).toBe("minimal");
  expect(asThoughtLevel("low")).toBe("low");
  expect(asThoughtLevel("medium")).toBe("medium");
  expect(asThoughtLevel("high")).toBe("high");
  expect(asThoughtLevel("xhigh")).toBe("xhigh");
  expect(asThoughtLevel("max")).toBe("max");
  expect(asThoughtLevel("ultra")).toBeUndefined();
  expect(asThoughtLevel(undefined)).toBeUndefined();
});

test("parseBoardTokens separates @mentions, #seq references, and [done]/[stall] tags", () => {
  expect(parseBoardTokens("@verifier [done] Verified #185 with @all")).toEqual([
    { kind: "mention", value: "@verifier" },
    { kind: "text", value: " " },
    { kind: "tag", value: "[done]" },
    { kind: "text", value: " Verified " },
    { kind: "seq", value: "#185" },
    { kind: "text", value: " with " },
    { kind: "mention", value: "@all" },
  ]);
});

const makeRuntimeInfo = (overrides: Partial<RuntimeInfo> = {}): RuntimeInfo => ({
  id: "antigravity",
  preset: {
    id: "antigravity",
    label: "Antigravity",
    blurb: "ACP",
    look: { species: null, outfit: null, orchestrator: null, build: "biped", head: "rounded", body: "blue", trim: "navy", hat: "slate", eye: "ink" },
  },
  support: { steer: true, refused: {}, capabilities: ["listModels"], inProcess: false, inSessionConfig: true },
  installation: { status: "available", via: "executable", command: "agy", version: "1.5.14" },
  models: [],
  usage: null,
  skills: null,
  mcpServers: null,
  tools: null,
  settings: { enabled: true, binPath: "", defaultModel: "", defaultEffort: "", env: {} },
  stop: "ok",
  checkedAt: 1_700_000_000_000,
  ...overrides,
});

test("toWorkspaceRuntime preserves empty effortLevels for models on runtimes that report per-model efforts", () => {
  const mixed = toWorkspaceRuntime(
    makeRuntimeInfo({
      models: [
        { id: "gemini-4-neon", name: "Gemini 4 Neon", effortLevels: ["low", "medium", "high", "xhigh"], defaultEffort: "high", isDefault: true },
        { id: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)", effortLevels: [], defaultEffort: "medium", isDefault: false },
      ],
      settings: { enabled: true, binPath: "", defaultModel: " gemini-pro-orchestrator-neon ", defaultEffort: "high", env: {} },
    }),
  );

  expect(mixed.defaultModel).toBe("gemini-pro-orchestrator-neon");
  expect(mixed.models[0]).toEqual({
    id: "gemini-4-neon",
    label: "Gemini 4 Neon",
    effortLevels: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
    isDefault: true,
  });
  expect(mixed.models[1]).toEqual({
    id: "gemini-pro-orchestrator-neon",
    label: "Orchestrator (Neon)",
    effortLevels: [],
    defaultEffort: undefined,
    isDefault: false,
  });

  const legacy = toWorkspaceRuntime(
    makeRuntimeInfo({
      id: "claude",
      models: [{ id: "sonnet", name: "Sonnet", effortLevels: [], isDefault: true }],
    }),
  );
  expect(legacy.models[0]?.effortLevels).toEqual(["low", "medium", "high"]);

  const refused = toWorkspaceRuntime(
    makeRuntimeInfo({
      support: { steer: true, refused: { effort: "not supported" }, capabilities: ["listModels"], inProcess: false, inSessionConfig: true },
      models: [
        { id: "m1", name: "Model 1", effortLevels: ["low", "high"], defaultEffort: "high", isDefault: true },
        { id: "m2", name: "Model 2", effortLevels: [], isDefault: false },
      ],
    }),
  );
  expect(refused.models.map((m) => m.effortLevels)).toEqual([[], []]);
  expect(refused.models.map((m) => m.defaultEffort)).toEqual([undefined, undefined]);

  const withQuota = toWorkspaceRuntime(
    makeRuntimeInfo({
      quota: { left: 74, text: "5h window" },
    }),
  );
  expect(withQuota.quotaPct).toBe(74);
  expect(withQuota.quotaText).toBe("5h window");

  const withWindowFallback = toWorkspaceRuntime(
    makeRuntimeInfo({
      usage: { status: "ok", subscription: null, windows: [{ label: "Gemini · 5h", usedPercent: 28, resetsAt: null }] },
    }),
  );
  expect(withWindowFallback.quotaPct).toBe(72);
  expect(withWindowFallback.quotaText).toBe("Gemini · 5h");
});

test("preferredModelFor, defaultThoughtLevelFor, and clampThoughtLevel select and clamp model effort cleanly", () => {
  const neon = {
    id: "gemini-4-neon",
    label: "Gemini 4 Neon",
    effortLevels: ["low", "medium", "high", "xhigh"] as const,
    defaultEffort: "high" as const,
    isDefault: true,
  };
  const orchestrator = {
    id: "gemini-pro-orchestrator-neon",
    label: "Orchestrator (Neon)",
    effortLevels: [] as const,
    defaultEffort: undefined,
    isDefault: false,
  };
  const fallbackFirst = { id: "plain", label: "Plain", effortLevels: ["low", "xhigh"] as const, defaultEffort: undefined, isDefault: false };

  expect(preferredModelFor(undefined)).toBeUndefined();
  expect(
    preferredModelFor({
      id: "antigravity",
      name: "Antigravity",
      available: true,
      models: [orchestrator, neon],
      defaultModel: "gemini-pro-orchestrator-neon",
      supportsSteer: true,
      supportsConfig: true,
    })?.id,
  ).toBe("gemini-pro-orchestrator-neon");
  expect(
    preferredModelFor({
      id: "antigravity",
      name: "Antigravity",
      available: true,
      models: [orchestrator, neon],
      supportsSteer: true,
      supportsConfig: true,
    })?.id,
  ).toBe("gemini-4-neon");
  expect(
    preferredModelFor({
      id: "antigravity",
      name: "Antigravity",
      available: true,
      models: [orchestrator, fallbackFirst],
      supportsSteer: true,
      supportsConfig: true,
    })?.id,
  ).toBe("gemini-pro-orchestrator-neon");

  expect(defaultThoughtLevelFor(undefined)).toBeUndefined();
  expect(defaultThoughtLevelFor(orchestrator)).toBeUndefined();
  expect(defaultThoughtLevelFor(neon)).toBe("high");
  expect(defaultThoughtLevelFor(fallbackFirst)).toBe("low");

  expect(clampThoughtLevel(undefined, "high")).toBeUndefined();
  expect(clampThoughtLevel(orchestrator, "high")).toBeUndefined();
  expect(clampThoughtLevel(neon, "xhigh")).toBe("xhigh");
  expect(clampThoughtLevel(neon, "max")).toBe("high");
  expect(clampThoughtLevel(neon, undefined)).toBe("high");
});

test("fetchWorkspaceRuntimes returns server preset labels without hardcoded fallback runtimes", async () => {
  const prev = transport();
  try {
    setTransport({
      ...prev,
      call: async () => ({ bizCode: 100009, message: "unavailable" }),
    });
    expect(await fetchWorkspaceRuntimes()).toEqual([]);

    setTransport({
      ...prev,
      call: async () => ({ bizCode: 0, message: "ok", data: [] }),
    });
    expect(await fetchWorkspaceRuntimes()).toEqual([]);

    setTransport({
      ...prev,
      call: async () => ({
        bizCode: 0,
        message: "ok",
        data: [
          makeRuntimeInfo({
            id: "custom-engine",
            preset: {
              ...makeRuntimeInfo().preset,
              id: "custom-engine",
              label: "Custom Engine",
            },
          }),
        ],
      }),
    });
    const list = await fetchWorkspaceRuntimes();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "custom-engine", name: "Custom Engine", available: true });
  } finally {
    setTransport(prev);
  }
});

test("groupChatSteps keeps single intermediate steps bare and aggregates consecutive steps", () => {
  const events: SessionEvent[] = [
    step(1, "user/message", { text: "Check ACP" }),
    step(2, "assistant/thinking", { text: "Inspecting mod.rs" }),
    step(3, "assistant/message", { text: "One step done." }),
    step(4, "user/message", { text: "Fix it and test" }),
    step(5, "assistant/thinking", { text: "Planning edits" }),
    step(6, "tool/call", { action: "read_file", input: JSON.stringify({ path: "src/a.rs", start_line: 10 }), ok: true }),
    step(7, "tool/call", { action: "search", input: JSON.stringify({ query: "Handshake", path: "src" }), ok: true }),
    step(8, "tool/call", { action: "edit_file", tool: "replace_file_content", input: JSON.stringify({ path: "src/a.rs", StartLine: 15 }), ok: true }),
    step(9, "tool/call", { action: "edit_file", tool: "replace_file_content", input: JSON.stringify({ path: "src/a.rs", StartLine: 42 }), ok: true }),
    step(10, "tool/call", { action: "run_command", input: JSON.stringify({ command: "cargo test" }), ok: false }),
  ];

  const items = groupChatSteps(events);
  expect(items.map((item) => item.kind)).toEqual(["step", "step", "step", "step", "activity"]);
  expect(items[1]).toMatchObject({ kind: "step", key: "s:2", durationMs: 1_000 });

  const cluster = items[4];
  expect(cluster?.kind).toBe("activity");
  if (cluster?.kind === "activity") {
    expect(cluster.key).toBe("g:5");
    expect(cluster.trailing).toBe(true);
    expect(cluster.summary).toEqual({
      totalSteps: 6,
      thinkingCount: 1,
      readCount: 1,
      searchCount: 1,
      editCount: 2,
      commandCount: 1,
      otherToolCount: 0,
      totalTools: 5,
      runningCount: 0,
      failedCount: 1,
      startedAt: 1_700_000_005_000,
      durationMs: 5_000,
      editedFiles: [{ path: "src/a.rs", line: 42, canDiff: true }],
      latestCommand: { seq: 10, command: "cargo test", running: false, failed: true },
    });
  }

  const runningPreference = groupChatSteps([
    step(1, "assistant/thinking", { text: "Checking" }),
    step(2, "tool/call", { action: "run_command", input: JSON.stringify({ command: "vp run mac:check" }), ok: undefined }),
    step(3, "tool/call", { action: "run_command", input: JSON.stringify({ command: "git status" }), ok: true }),
  ]);
  const runningCluster = runningPreference[0];
  expect(runningCluster?.kind).toBe("activity");
  if (runningCluster?.kind === "activity") {
    expect(runningCluster.summary.latestCommand).toEqual({
      seq: 2,
      command: "vp run mac:check",
      running: true,
      failed: false,
    });
  }

  const loneTrailing = groupChatSteps([step(1, "assistant/thinking", { text: "Still thinking" })]);
  expect(loneTrailing[0]).toMatchObject({ kind: "step", key: "s:1", trailing: true });
});

test("parseTodoChecklist and latestSessionTodos parse update_steps, TodoWrite, and update_plan payloads", () => {
  const step1 = step(1, "tool/call", {
    tool: "update_steps",
    action: "other",
    input: JSON.stringify({
      steps: [
        { status: "done", title: "Simplify Content Hub source filter & docs" },
        { status: "in_progress", title: "Unify Artifact single-row header & dropdown" },
        { status: "pending", title: "Verify native screenshots" },
        { status: "skipped", title: "Optional cleanup" },
        { status: "failed", title: "Broken check" },
      ],
      kind: "other",
    }),
  });
  const parsed = parseTodoChecklist(step1);
  expect(parsed).toEqual({
    seq: 1,
    doneCount: 1,
    inProgressCount: 1,
    failedCount: 1,
    totalCount: 5,
    activeStep: { status: "in_progress", title: "Unify Artifact single-row header & dropdown" },
    steps: [
      { status: "done", title: "Simplify Content Hub source filter & docs" },
      { status: "in_progress", title: "Unify Artifact single-row header & dropdown" },
      { status: "pending", title: "Verify native screenshots" },
      { status: "skipped", title: "Optional cleanup" },
      { status: "failed", title: "Broken check" },
    ],
  });
  expect(formatToolDetails(step1).headline).toBe("1/5 · Unify Artifact single-row header & dropdown");

  const step2 = step(2, "tool/call", {
    tool: "TodoWrite",
    input: JSON.stringify({ todos: [{ content: "Write docs", status: "completed" }] }),
  });
  expect(parseTodoChecklist(step2)?.doneCount).toBe(1);

  const step3 = step(3, "tool/call", {
    tool: "update_plan",
    input: JSON.stringify({ plan: [{ step: "Run tests", status: "in-progress" }] }),
  });
  expect(parseTodoChecklist(step3)?.inProgressCount).toBe(1);

  expect(latestSessionTodos([step1, step2, step3])?.seq).toBe(3);
  expect(parseTodoChecklist(step(4, "tool/call", { tool: "run_command", input: JSON.stringify({ command: "ls" }) }))).toBeUndefined();
});

test("formatToolDetails, formatDurationMs, and thinkingPreview extract scannable summaries", () => {
  expect(formatDurationMs(420)).toBe("420ms");
  expect(formatDurationMs(4_240)).toBe("4.2s");
  expect(formatDurationMs(72_000)).toBe("1m 12s");
  expect(formatDurationMs(undefined)).toBeUndefined();

  expect(thinkingPreview("  Line one\n\n  Line two  ")).toBe("Line one Line two");
  expect(thinkingPreview("a".repeat(20), 10)).toBe("aaaaaaaaa…");

  const cmd = formatToolDetails(
    step(1, "tool/call", {
      action: "run_command",
      input: JSON.stringify({ command: "cargo test -p vibevalley-mac", cwd: "/work/vibevalley" }),
      output: "running 1 test\nok",
    }),
  );
  expect(cmd).toEqual({
    headline: "$ cargo test -p vibevalley-mac",
    formattedInput: "$ cargo test -p vibevalley-mac\ncwd: /work/vibevalley",
    outputLines: 2,
  });

  const search = formatToolDetails(
    step(2, "tool/call", {
      action: "search",
      input: JSON.stringify({ query: "groupChatSteps", path: "apps/mac/ui" }),
    }),
  );
  expect(search.headline).toBe("groupChatSteps in apps/mac/ui");

  const edit = formatToolDetails(
    step(3, "tool/call", {
      action: "edit_file",
      input: JSON.stringify({ path: "src/lib.rs", StartLine: 12, EndLine: 28 }),
    }),
  );
  expect(edit.headline).toBe("src/lib.rs:12-28");
  expect(edit.formattedInput).toBe('{\n  "path": "src/lib.rs",\n  "StartLine": 12,\n  "EndLine": 28\n}');
  expect(edit.outputLines).toBe(0);
});

test("regression: setWorkspaceConfig and watchWorkspaceSession log and report malformed payloads", async () => {
  const prev = transport();
  const origConsoleError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };

  try {
    let pushWatchFrame: ((raw: unknown) => void) | undefined;
    setTransport({
      ...prev,
      call: async () => ({ bizCode: 0, message: "ok", data: { unexpected: true } }),
      subscribe: (_channel, _payload, onData) => {
        pushWatchFrame = onData;
        return () => {};
      },
    });

    const configResult = await setWorkspaceConfig("sess-bad", { model: "deepseek-chat" });
    expect(configResult.ok).toBe(false);
    if (!configResult.ok) {
      expect(configResult.reason.length).toBeGreaterThan(0);
    }
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[0])).toContain("session.setConfig");

    const received: unknown[] = [];
    const stop = watchWorkspaceSession("sess-bad", (ev) => received.push(ev));
    pushWatchFrame?.({ kind: "not-a-valid-watch-event" });
    stop();
    expect(received).toHaveLength(0);
    expect(logged).toHaveLength(2);
    expect(String(logged[1]?.[0])).toContain("session.watch");
  } finally {
    console.error = origConsoleError;
    setTransport(prev);
  }
});
