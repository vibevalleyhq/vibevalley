import "../infra/polyfill";
import { expect, test } from "nsh/test";

import type { RuntimeInfo, SessionEvent } from "@vibevalley/protocol";

import { setCoreBridgeForTest } from "../infra/rich";
import { setTransport, transport } from "../infra/transport";
import {
  clampThoughtLevel,
  computeTelemetry,
  defaultThoughtLevelFor,
  extractToolTarget,
  fetchWorkspaceRuntimes,
  formatDurationMs,
  formatTokens,
  formatToolDetails,
  parseBoardTokens,
  preferredModelFor,
  setWorkspaceConfig,
  thinkingPreview,
  toWorkspaceRuntime,
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

test("thin chatSession bindings forward to Rust VvCore bridge cleanly", () => {
  expect(formatTokens(62_400)).toBe("62.4k");
  expect(formatTokens(1_000_000)).toBe("1M");
  expect(formatDurationMs(420)).toBe("420ms");
  expect(formatDurationMs(4_240)).toBe("4.2s");
  expect(formatDurationMs(72_000)).toBe("1m 12s");
  expect(formatDurationMs(undefined)).toBeUndefined();
  expect(thinkingPreview("  Line one\n\n  Line two  ")).toBe("Line one Line two");
  expect(thinkingPreview("a".repeat(20), 10)).toBe("aaaaaaaaa…");

  const restore = setCoreBridgeForTest({
    extractToolTarget: () => JSON.stringify({ path: "src/lib.rs", line: 42, canDiff: true }),
    parseBoardTokens: () => JSON.stringify([{ kind: "mention", value: "@verifier" }]),
    formatToolDetails: () => JSON.stringify({ headline: "$ cargo test", formattedInput: "$ cargo test", outputLines: 2 }),
    projectChatSession: () =>
      JSON.stringify({
        visibleSteps: [],
        feedItems: [],
        toolEntries: [],
        telemetry: {
          cachedRead: 62_400,
          uncachedInput: 13_600,
          totalInput: 76_000,
          output: 6_800,
          reasoning: 2_100,
          contextUsed: 76_000,
          contextWindow: 200_000,
          contextPct: 38,
          cacheHitPct: 82,
          turns: 1,
          toolCount: 1,
          hasData: true,
        },
      }),
  });
  try {
    expect(extractToolTarget(step(1, "tool/call", { action: "edit_file" }))).toEqual({ path: "src/lib.rs", line: 42, canDiff: true });
    expect(parseBoardTokens("@verifier")).toEqual([{ kind: "mention", value: "@verifier" }]);
    expect(formatToolDetails(step(2, "tool/call", { action: "run_command" })).headline).toBe("$ cargo test");
    expect(computeTelemetry([]).contextPct).toBe(38);
  } finally {
    restore();
  }
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
