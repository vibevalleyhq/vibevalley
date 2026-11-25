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
  formatTokens,
  mergeChatSteps,
  parseBoardTokens,
  preferredModelFor,
  toWorkspaceRuntime,
  visibleChatSteps,
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
