import "../infra/polyfill";
import { expect, test } from "nsh/test";

import type { SessionEvent } from "@vibevalley/protocol";

import {
  asThoughtLevel,
  computeTelemetry,
  deriveChatTitle,
  extractToolTarget,
  formatTokens,
  mergeChatSteps,
  parseBoardTokens,
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

test("deriveChatTitle prefers real session title, then swarm title, then clean clipped first user message", () => {
  expect(deriveChatTitle("  Fix ACP titles  ", "Swarm Title", "First prompt")).toBe("Fix ACP titles");
  expect(deriveChatTitle("   ", "Unified Content Hub", "First prompt")).toBe("Unified Content Hub");
  expect(deriveChatTitle(undefined, undefined, "\n\n  Refactor   sidebar\t\tmenu\nsecond line")).toBe("Refactor sidebar menu");
  expect(deriveChatTitle(undefined, undefined, "1234567890123456789012345678901234567890")).toBe("12345678901234567890123456789012345…");
  expect(deriveChatTitle(undefined, "  ", "   \n  ")).toBeUndefined();
});
