// ToolCallCard: one tool call of an agent. One quiet line first (icon, name
// in mono, summary, status, chevron); the arguments and the result open in
// place below it as highlighted JSON with copy buttons; long blocks are
// capped with a fade and "Show all"; errors show in a tinted box with Retry.
// Ported from affectUI's Tool Call Card (free).
//
// affectUI is MIT licensed: Copyright (c) affectUI contributors. Permission
// is hereby granted, free of charge, to any person obtaining a copy of this
// software, to deal in it without restriction, provided this notice is kept.
import { announce, cleanup, Clipboard, createMotion, effect, reduceMotion, Scroll, signal, Text, untracked, View } from "nsh";
import type { JSX } from "nsh";
import { Button } from "nsh/base";

import { animateLayout, durations, ease, ms } from "../motion";
import { cardShadow, dangerTint, radius, tok, type as ty, type Palette } from "../tokens";
import type { AgentEvent } from "./shapes";

export type ToolCallStatus = "running" | "done" | "failed";

/** One `ToolCallStarted` / `ToolCallFinished` pair of an agent's events. */
export type ToolCall = {
  id: string;
  name: string;
  summary: string;
  status: ToolCallStatus;
  startedMs: number;
  endedMs: number | null;
  input: unknown;
  output: string | null;
  /** The failure's message: the output of a call that finished not ok. */
  error: string | null;
};

export type ToolCallCardProps = {
  call: ToolCall;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Reruns the turn; shows Retry next to the error. */
  onRetry?: () => void;
  /** Inside a ToolCallGroup: no ring of its own. */
  nested?: boolean;
};

const CAP = 220;
const OPEN_MAX = 640;

/** The short human line for a call, read from its arguments. */
function callSummary(name: string, input: unknown): string {
  if (input === null || typeof input !== "object") return typeof input === "string" ? input : "";
  const o = input as Record<string, unknown>;
  for (const key of ["description", "command", "file_path", "path", "pattern", "query", "url", "prompt"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.split("\n")[0];
  }
  if (Array.isArray(o.changes)) return `${o.changes.length} file change${o.changes.length === 1 ? "" : "s"}`;
  return name;
}

/** The line of a failed call's output that says what went wrong: its last; the whole output stays under Result. */
function errorLine(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "The tool call failed.";
}

/** Pairs started and finished events into calls, oldest first. */
export function callsFromEvents(events: AgentEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  for (const e of events) {
    const k = e.kind;
    if (k.type === "tool_call_started") {
      const call: ToolCall = {
        id: k.id,
        name: k.name,
        summary: callSummary(k.name, k.input),
        status: "running",
        startedMs: e.at_ms,
        endedMs: null,
        input: k.input,
        output: null,
        error: null,
      };
      byId.set(k.id, call);
      calls.push(call);
    } else if (k.type === "tool_call_finished") {
      const call = byId.get(k.id);
      if (!call) continue;
      call.status = k.ok ? "done" : "failed";
      call.endedMs = e.at_ms;
      call.output = k.output;
      if (!k.ok) call.error = errorLine(k.output);
    }
  }
  return calls;
}

/** 0.4s, 12.3s, 2m 05s, 3h 12m; a finished call under a second reads 420ms. */
export function formatMs(msElapsed: number, live: boolean): string {
  if (!live && msElapsed < 1000) return `${Math.max(1, Math.round(msElapsed))}ms`;
  if (msElapsed < 60_000) return `${(Math.floor(msElapsed / 100) / 10).toFixed(1)}s`;
  const s = Math.floor(msElapsed / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(s / 3600);
  if (h < 24) return `${h}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The icon tile's glyph for a tool, by what the tool does. */
export function toolGlyph(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("bash") || n.includes("shell") || n.includes("command") || n.includes("exec")) return "$";
  if (n.includes("read") || n.includes("view")) return "◱";
  if (n.includes("edit") || n.includes("write") || n.includes("patch") || n.includes("filechange")) return "✎";
  if (n.includes("grep") || n.includes("glob") || n.includes("search") || n.includes("find")) return "⌕";
  if (n.includes("fetch") || n.includes("web")) return "◎";
  if (n.startsWith("mcp")) return "⧉";
  return "⚒";
}

/** Live ms while running; a stopwatch per component, ticking every 100 ms. */
export function useStopwatch(running: () => boolean, from: () => number): () => number {
  const now = signal(Date.now());
  effect(() => {
    if (!running()) return;
    now.set(Date.now());
    const t = setInterval(() => now.set(Date.now()), durations.timerTick);
    cleanup(() => clearInterval(t));
  });
  return () => Math.max(0, now() - from());
}

/** The status enters as affectUI's does: opacity 0→1, 3 px rise, 360 ms. */
export function useSwapIn(key: () => unknown) {
  const m = createMotion();
  let first = true;
  effect(() => {
    key();
    if (first) {
      first = false;
      return;
    }
    untracked(() => {
      if (reduceMotion()) return;
      void m.play({ duration: durations.statusSwap, keyframes: { opacity: [0, 1], translateY: [3, 0] } });
    });
  });
  return m;
}

export function IconTile(props: { glyph: string; size?: number }) {
  const p = () => tok();
  const size = () => props.size ?? 26;
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: size(),
        height: size(),
        flexShrink: 0,
        borderRadius: radius.sm,
        backgroundColor: p().tile,
        borderWidth: 1,
        borderColor: p().border,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontSize: 12, lineHeight: 14, color: p().text, fontFamily: ty.mono.fontFamily }}>{props.glyph}</Text>
    </View>
  );
}

function Spinner(props: { color?: string }) {
  const p = () => tok();
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: 12,
        height: 12,
        borderRadius: 6,
        borderWidth: 1.5,
        borderColor: p().border,
        borderTopColor: props.color ?? p().muted,
        animationName: reduceMotion() ? "none" : "spin",
        animationDuration: durations.spinner,
        animationTimingFunction: "linear",
      }}
    />
  );
}

function ErrorMark() {
  const p = () => tok();
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: 13,
        height: 13,
        borderRadius: 7,
        borderWidth: 1.4,
        borderColor: p().danger,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Text style={{ fontSize: 9, lineHeight: 10, fontWeight: "700", color: p().danger }}>!</Text>
    </View>
  );
}

/** Running: spinner + live timer. Done: check + duration. Failed: error mark + "Failed". */
function CallStatus(props: { status: ToolCallStatus; startedMs: number; endedMs: number | null }) {
  const p = () => tok();
  const live = useStopwatch(
    () => props.status === "running",
    () => props.startedMs,
  );
  const elapsed = () => (props.endedMs != null ? props.endedMs - props.startedMs : live());
  const swap = useSwapIn(() => props.status);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0, ...swap.style }}>
      {props.status === "running" ? <Spinner /> : null}
      {props.status === "done" ? <Text style={{ fontSize: 12, lineHeight: 14, color: p().ok }}>✓</Text> : null}
      {props.status === "failed" ? <ErrorMark /> : null}
      <Text
        style={{
          ...ty.mono,
          fontSize: 12,
          color: props.status === "failed" ? p().danger : p().muted,
          fontVariant: ["tabular-nums"],
        }}
      >
        {props.status === "failed" ? "Failed" : formatMs(elapsed(), props.status === "running")}
      </Text>
    </View>
  );
}

export function Chevron(props: { open: boolean }) {
  return (
    <Text
      accessibilityElementsHidden
      style={{
        width: 16,
        textAlign: "center",
        fontSize: 12,
        lineHeight: 16,
        color: tok().muted,
        flexShrink: 0,
        transform: [{ rotate: props.open ? "180deg" : "0deg" }],
        transitionProperty: "transform",
        transitionDuration: ms(durations.chevron),
        transitionTimingFunction: ease,
      }}
    >
      ⌄
    </Text>
  );
}

function toText(value: unknown): { text: string; json: boolean } {
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return { text: JSON.stringify(JSON.parse(t), null, 2), json: true };
      } catch {
        // not JSON: shown as plain text
      }
    }
    return { text: value, json: false };
  }
  try {
    const s = JSON.stringify(value, null, 2);
    return s === undefined ? { text: String(value), json: false } : { text: s, json: true };
  } catch {
    return { text: String(value), json: false };
  }
}

// Strings (keys when a colon follows), literals and numbers; the rest is punctuation.
const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function highlight(text: string, p: Palette): JSX.Element[] {
  const out: JSX.Element[] = [];
  const re = new RegExp(TOKEN.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<Text style={{ color: p.text }}>{text.slice(last, m.index)}</Text>);
    if (m[1] && m[2]) {
      out.push(<Text style={{ color: p.codeKey }}>{m[1]}</Text>);
      out.push(<Text style={{ color: p.text }}>{m[2]}</Text>);
    } else if (m[1]) out.push(<Text style={{ color: p.codeStr }}>{m[1]}</Text>);
    else if (/^[tfn]/.test(m[0])) out.push(<Text style={{ color: p.codeLit }}>{m[0]}</Text>);
    else out.push(<Text style={{ color: p.codeNum }}>{m[0]}</Text>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<Text style={{ color: p.text }}>{text.slice(last)}</Text>);
  return out;
}

function CopyButton(props: { text: string; label: string }) {
  const p = () => tok();
  const copied = signal(false);
  let timer: number | undefined;
  cleanup(() => clearTimeout(timer));
  const copy = () => {
    void Clipboard.writeText(props.text).then(() => {
      copied.set(true);
      clearTimeout(timer);
      timer = setTimeout(() => copied.set(false), durations.copyConfirm);
    });
  };
  return (
    <Button
      onPress={copy}
      accessibilityLabel={copied() ? "Copied" : `Copy ${props.label}`}
      tooltip={<Text>{copied() ? "Copied" : `Copy ${props.label}`}</Text>}
      style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" }}
      hoverStyle={{ backgroundColor: p().subtle }}
      focusVisibleStyle={{ outlineWidth: 2, outlineColor: p().focus, outlineOffset: 2, outlineStyle: "solid" }}
    >
      <Text
        style={{
          fontSize: 12,
          lineHeight: 14,
          color: copied() ? p().ok : p().muted,
          transitionProperty: "colors",
          transitionDuration: ms(durations.press),
        }}
      >
        {copied() ? "✓" : "⧉"}
      </Text>
    </Button>
  );
}

/** A labelled block of code: copy on the right, capped at 220 px with a fade and "Show all", 640 px with an inner scroll when open. */
function CodeSection(props: { label: string; value: unknown; tone?: "danger"; testID?: string }) {
  const p = () => tok();
  const shown = () => toText(props.value);
  const full = signal(false);
  const height = signal(0);
  const capped = () => height() > CAP + 24;
  const maxHeight = () => (capped() ? (full() ? Math.min(height(), OPEN_MAX) : CAP) : undefined);
  return (
    <View style={{ gap: 6 }} testID={props.testID}>
      <View style={{ flexDirection: "row", alignItems: "center", height: 24 }}>
        <Text style={{ ...ty.label, color: p().muted, flex: 1 }}>{props.label}</Text>
        <CopyButton text={shown().text} label={props.label.toLowerCase()} />
      </View>
      <View style={{ backgroundColor: p().tile, borderRadius: radius.sm, overflow: "hidden" }}>
        <Scroll style={{ maxHeight: maxHeight() }} scrollable={capped() && full() && height() > OPEN_MAX}>
          <Text
            onLayout={(e) => height.set(e.bounds.size.height)}
            style={{
              ...ty.code,
              userSelect: "text",
              color: props.tone === "danger" ? p().danger : p().ink,
              paddingHorizontal: 12,
              paddingVertical: 10,
              writingDirection: "auto",
            }}
          >
            {shown().json ? highlight(shown().text, p()) : shown().text}
          </Text>
        </Scroll>
        {capped() && !full() ? (
          // GPUI draws no mask, so the fade is a gradient over the code.
          <View
            accessibilityElementsHidden
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: 48,
              backgroundImage: `linear-gradient(to bottom, ${alpha(p().tile, 0)}, ${p().tile})`,
            }}
          />
        ) : null}
      </View>
      {capped() ? (
        <View
          onPress={() => {
            animateLayout(durations.expandHeight);
            full.set(!full());
          }}
          role="button"
          accessibilityState={{ expanded: full() }}
          style={{ alignSelf: "flex-start", height: 24, paddingHorizontal: 8, marginLeft: -8, borderRadius: 6, justifyContent: "center" }}
          hoverStyle={{ backgroundColor: p().subtle }}
          focusVisibleStyle={{ outlineWidth: 2, outlineColor: p().focus, outlineOffset: 2, outlineStyle: "solid" }}
        >
          <Text style={{ ...ty.label, fontWeight: "500", color: p().ink }}>{full() ? "Show less" : "Show all"}</Text>
        </View>
      ) : null}
    </View>
  );
}

// A token at `a` opacity (a fade's transparent end), until tokens.ts has one.
function alpha(color: string, a: number): string {
  if (color.startsWith("#") && color.length === 7) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return color.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, `rgba($1,$2,$3,${a})`);
}

export function ToolCallCard(props: ToolCallCardProps) {
  const p = () => tok();
  const open = signal(props.defaultOpen ?? props.call.status === "failed");
  let autoOpened = open() && props.call.status === "failed";
  // Opens on failure, closes on the next run, unless someone toggled it.
  let prev = props.call.status;
  effect(() => {
    const status = props.call.status;
    untracked(() => {
      if (status === prev) return;
      const was = prev;
      prev = status;
      announce(status === "running" ? `${props.call.name} running` : status === "done" ? `${props.call.name} finished` : `${props.call.name} failed`);
      if (status === "failed" && !open()) {
        animateLayout();
        open.set(true);
        autoOpened = true;
      } else if (was === "failed" && autoOpened) {
        animateLayout();
        open.set(false);
        autoOpened = false;
      }
    });
  });
  const toggle = () => {
    autoOpened = false;
    animateLayout();
    open.set(!open());
    props.onOpenChange?.(open());
  };
  const tint = () => dangerTint(p());
  const body = createMotion({ initial: { opacity: open() ? 1 : 0 } });
  effect(() => {
    if (open()) void body.play({ duration: ms(durations.expandOpacity), keyframes: { opacity: [0, 1] } });
  });
  return (
    <View
      testID={`tool-call-${props.call.id}`}
      style={{
        borderRadius: props.nested ? 0 : radius.card,
        backgroundColor: props.nested ? "transparent" : p().surface,
        boxShadow: props.nested ? [] : cardShadow(p()),
        overflow: "hidden",
      }}
    >
      <View
        onPress={toggle}
        role="button"
        accessibilityLabel={`${props.call.name}: ${props.call.summary}`}
        accessibilityState={{ expanded: open() }}
        style={{
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingLeft: 10,
          paddingRight: 12,
          transitionProperty: "colors,transform",
          transitionDuration: ms(durations.press),
          transitionTimingFunction: "ease",
        }}
        hoverStyle={{ backgroundColor: p().subtle }}
        activeStyle={{ transform: [{ scale: 0.98 }] }}
        focusVisibleStyle={{ outlineWidth: 2, outlineColor: p().focus, outlineOffset: -2, outlineStyle: "solid" }}
      >
        <IconTile glyph={toolGlyph(props.call.name)} />
        <Text style={{ ...ty.mono, color: p().ink, numberOfLines: 1, flexShrink: 0, maxWidth: 180 }}>{props.call.name}</Text>
        <Text style={{ ...ty.body, color: p().text, flex: 1, minWidth: 0, numberOfLines: 1, writingDirection: "auto" }}>{props.call.summary}</Text>
        <CallStatus status={props.call.status} startedMs={props.call.startedMs} endedMs={props.call.endedMs} />
        <Chevron open={open()} />
      </View>
      {open() ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12, paddingTop: 2, gap: 12, ...body.style }}>
          {props.call.status === "failed" ? (
            <View
              role="alert"
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 8,
                backgroundColor: tint().fill,
                borderWidth: 1,
                borderColor: tint().ring,
                borderRadius: radius.sm,
                padding: 10,
              }}
            >
              <View style={{ paddingTop: 3 }}>
                <ErrorMark />
              </View>
              <Text style={{ ...ty.body, fontSize: 13, color: p().danger, flex: 1, numberOfLines: 4, writingDirection: "auto" }}>
                {props.call.error ?? "The tool call failed."}
              </Text>
              {props.onRetry ? (
                <Button
                  onPress={() => props.onRetry?.()}
                  style={{
                    height: 30,
                    paddingHorizontal: 12,
                    borderRadius: radius.button,
                    backgroundColor: p().surface,
                    boxShadow: [{ x: 0, y: 0, blur: 0, spread: 1, color: p().border, inset: false }],
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    flexShrink: 0,
                  }}
                  hoverStyle={{ backgroundColor: p().subtle }}
                  activeStyle={{ transform: [{ scale: 0.98 }] }}
                  focusVisibleStyle={{ outlineWidth: 2, outlineColor: p().focus, outlineOffset: 2, outlineStyle: "solid" }}
                >
                  <Text style={{ fontSize: 12, color: p().ink }}>↻</Text>
                  <Text style={{ ...ty.label, fontWeight: "500", color: p().ink }}>Retry</Text>
                </Button>
              ) : null}
            </View>
          ) : null}
          {props.call.input != null ? <CodeSection label="Arguments" value={props.call.input} testID="arguments" /> : null}
          {props.call.output != null && props.call.output !== "" ? (
            <CodeSection label="Result" value={props.call.output} tone={props.call.status === "failed" ? "danger" : undefined} testID="result" />
          ) : props.call.status === "running" ? (
            <View style={{ gap: 6 }}>
              <Text style={{ ...ty.label, color: p().muted }}>Result</Text>
              <Text style={{ ...ty.body, fontSize: 13, color: p().muted }}>Waiting for result…</Text>
            </View>
          ) : null}
          {props.call.input == null && !props.call.output && props.call.status === "done" ? (
            <Text style={{ ...ty.body, fontSize: 13, color: p().muted }}>No arguments or result.</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
