// ToolCallCard: one tool call of an agent. One quiet line first (icon, name
// in mono, summary, status, chevron); the arguments and the result open in
// place below it as highlighted JSON with copy buttons; long blocks are
// capped with a fade and "Show all"; errors show in a tinted box with Retry.
// Ported from affectUI's Tool Call Card (free).
//
// affectUI is MIT licensed: Copyright (c) affectUI contributors. Permission
// is hereby granted, free of charge, to any person obtaining a copy of this
// software, to deal in it without restriction, provided this notice is kept.
import { announce, Canvas, cleanup, Clipboard, colorScheme, createMotion, effect, reduceMotion, Scroll, signal, Text, untracked, View } from "nsh";
import type { CanvasRenderingContext2D, JSX } from "nsh";
import { Button } from "nsh/base";

import { animateLayout, durations, ease, ms } from "../motion";
import { SurfaceIcon, TipBubble } from "../surfaces/shared";
import { cardShadow, dangerTint, radius, tint, tok, type as ty, type Palette } from "../tokens";
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
  for (const key of ["description", "command", "file_path", "path", "pattern", "query", "url", "prompt"]) {
    const v: unknown = Reflect.get(input, key);
    if (typeof v === "string" && v.trim()) return v.split("\n")[0];
  }
  const changes: unknown = Reflect.get(input, "changes");
  if (Array.isArray(changes)) return `${changes.length} file change${changes.length === 1 ? "" : "s"}`;
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

function drawToolIcon(cx: CanvasRenderingContext2D, glyph: string, size: number, color: string) {
  cx.scale(size / 16, size / 16);
  cx.strokeStyle = color;
  cx.fillStyle = color;
  cx.lineCap = "round";
  cx.lineJoin = "round";
  cx.lineWidth = 1.45 * (16 / size);

  switch (glyph) {
    case "$":
      cx.beginPath();
      cx.moveTo(3.25, 4.75);
      cx.lineTo(6.75, 8);
      cx.lineTo(3.25, 11.25);
      cx.moveTo(8.5, 11.25);
      cx.lineTo(12.75, 11.25);
      cx.stroke();
      break;
    case "◱":
      cx.beginPath();
      cx.moveTo(4.5, 2.5);
      cx.lineTo(9.25, 2.5);
      cx.lineTo(12.25, 5.5);
      cx.lineTo(12.25, 12.5);
      cx.quadraticCurveTo(12.25, 13.5, 11.25, 13.5);
      cx.lineTo(4.5, 13.5);
      cx.quadraticCurveTo(3.5, 13.5, 3.5, 12.5);
      cx.lineTo(3.5, 3.5);
      cx.quadraticCurveTo(3.5, 2.5, 4.5, 2.5);
      cx.closePath();
      cx.moveTo(9.25, 2.5);
      cx.lineTo(9.25, 5.5);
      cx.lineTo(12.25, 5.5);
      cx.stroke();
      break;
    case "✎":
      cx.beginPath();
      cx.moveTo(10.75, 2.75);
      cx.lineTo(13.25, 5.25);
      cx.lineTo(6, 12.5);
      cx.lineTo(2.75, 13.25);
      cx.lineTo(3.5, 10);
      cx.closePath();
      cx.stroke();
      break;
    case "⌕":
      cx.beginPath();
      cx.arc(7, 7, 3.75, 0, Math.PI * 2);
      cx.moveTo(9.8, 9.8);
      cx.lineTo(13, 13);
      cx.stroke();
      break;
    case "◎":
      cx.beginPath();
      cx.arc(8, 8, 5, 0, Math.PI * 2);
      cx.moveTo(3, 8);
      cx.lineTo(13, 8);
      cx.moveTo(8, 3);
      cx.quadraticCurveTo(10.6, 8, 8, 13);
      cx.moveTo(8, 3);
      cx.quadraticCurveTo(5.4, 8, 8, 13);
      cx.stroke();
      break;
    case "⧉":
      cx.beginPath();
      cx.moveTo(3, 5);
      cx.lineTo(9, 5);
      cx.lineTo(9, 11);
      cx.lineTo(3, 11);
      cx.closePath();
      cx.moveTo(7, 5);
      cx.lineTo(7, 3);
      cx.lineTo(13, 3);
      cx.lineTo(13, 9);
      cx.lineTo(9, 9);
      cx.stroke();
      break;
    default:
      cx.beginPath();
      cx.moveTo(3, 5);
      cx.lineTo(13, 5);
      cx.moveTo(3, 11);
      cx.lineTo(13, 11);
      cx.stroke();
      cx.beginPath();
      cx.arc(6, 5, 1.5, 0, Math.PI * 2);
      cx.fill();
      cx.beginPath();
      cx.arc(10.5, 11, 1.5, 0, Math.PI * 2);
      cx.fill();
      break;
  }
}

export function IconTile(props: { glyph: string; size?: number }) {
  const p = () => tok();
  const size = () => props.size ?? 22;
  const iconSize = () => Math.max(11, Math.round(size() * 0.56));
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: size(),
        height: size(),
        flexShrink: 0,
        borderRadius: 6,
        backgroundColor: p().tile,
        borderWidth: 1,
        borderColor: p().border,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Canvas
        style={{ width: iconSize(), height: iconSize(), flexShrink: 0 }}
        draw={(cx) => {
          void colorScheme();
          drawToolIcon(cx, props.glyph, iconSize(), tok().text);
        }}
      />
    </View>
  );
}

export function Spinner(props: { color?: string; size?: number }) {
  const p = () => tok();
  const size = () => props.size ?? 12;
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: size(),
        height: size(),
        borderRadius: size() / 2,
        borderWidth: 1.5,
        borderColor: p().subtle,
        borderTopColor: props.color ?? p().ink,
        animationName: reduceMotion() ? "none" : "spin",
        animationDuration: durations.spinner,
        animationTimingFunction: "linear",
        flexShrink: 0,
      }}
    />
  );
}

export function ErrorMark(props: { size?: number }) {
  const size = () => props.size ?? 13;
  return (
    <Canvas
      accessibilityElementsHidden
      style={{ width: size(), height: size(), flexShrink: 0 }}
      draw={(cx) => {
        void colorScheme();
        const color = tok().danger;
        const s = size();
        cx.scale(s / 16, s / 16);
        cx.strokeStyle = color;
        cx.fillStyle = color;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        cx.lineWidth = 1.5 * (16 / s);
        cx.beginPath();
        cx.arc(8, 8, 5.75, 0, Math.PI * 2);
        cx.moveTo(8, 4.75);
        cx.lineTo(8, 8.75);
        cx.stroke();
        cx.beginPath();
        cx.arc(8, 11.4, 0.9, 0, Math.PI * 2);
        cx.fill();
      }}
    />
  );
}

function CopyIcon(props: { size?: number; color?: string }) {
  const size = () => props.size ?? 12;
  return (
    <Canvas
      accessibilityElementsHidden
      style={{ width: size(), height: size(), flexShrink: 0 }}
      draw={(cx) => {
        void colorScheme();
        const color = props.color ?? tok().muted;
        const s = size();
        cx.scale(s / 16, s / 16);
        cx.strokeStyle = color;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        cx.lineWidth = 1.45 * (16 / s);
        cx.beginPath();
        cx.moveTo(6.25, 5.25);
        cx.lineTo(12.25, 5.25);
        cx.quadraticCurveTo(13.25, 5.25, 13.25, 6.25);
        cx.lineTo(13.25, 12.25);
        cx.quadraticCurveTo(13.25, 13.25, 12.25, 13.25);
        cx.lineTo(6.25, 13.25);
        cx.quadraticCurveTo(5.25, 13.25, 5.25, 12.25);
        cx.lineTo(5.25, 6.25);
        cx.quadraticCurveTo(5.25, 5.25, 6.25, 5.25);
        cx.closePath();
        cx.moveTo(3.75, 10.25);
        cx.quadraticCurveTo(2.75, 10.25, 2.75, 9.25);
        cx.lineTo(2.75, 3.75);
        cx.quadraticCurveTo(2.75, 2.75, 3.75, 2.75);
        cx.lineTo(9.25, 2.75);
        cx.quadraticCurveTo(10.25, 2.75, 10.25, 3.75);
        cx.stroke();
      }}
    />
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
      <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        {props.status === "running" ? <Spinner /> : null}
        {props.status === "done" ? <SurfaceIcon name="check" size={12} color={p().ok} strokeWidth={1.7} /> : null}
        {props.status === "failed" ? <ErrorMark /> : null}
      </View>
      <Text
        style={{
          fontFamily: ty.mono.fontFamily,
          fontSize: 11.5,
          lineHeight: 16,
          fontWeight: props.status === "failed" ? "500" : "400",
          color: props.status === "failed" ? p().danger : p().muted,
          fontVariant: ["tabular-nums"],
        }}
      >
        {props.status === "failed" ? "Failed" : formatMs(elapsed(), props.status === "running")}
      </Text>
    </View>
  );
}

export function Chevron(props: { open: boolean; size?: number; color?: string }) {
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: 14,
        height: 14,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        transform: [{ rotate: props.open ? "90deg" : "0deg" }],
        transitionProperty: "transform",
        transitionDuration: ms(durations.chevron),
        transitionTimingFunction: ease,
      }}
    >
      <SurfaceIcon name="chevron-right" size={props.size ?? 11} color={props.color ?? tok().muted} />
    </View>
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
const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu;

function highlight(text: string, p: Palette): JSX.Element[] {
  const out: JSX.Element[] = [];
  const re = new RegExp(TOKEN.source, "gu");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<Text style={{ color: p.text }}>{text.slice(last, m.index)}</Text>);
    if (m[1] && m[2]) {
      out.push(<Text style={{ color: p.codeKey }}>{m[1]}</Text>);
      out.push(<Text style={{ color: p.text }}>{m[2]}</Text>);
    } else if (m[1]) out.push(<Text style={{ color: p.codeStr }}>{m[1]}</Text>);
    else if (/^[tfn]/u.test(m[0])) out.push(<Text style={{ color: p.codeLit }}>{m[0]}</Text>);
    else out.push(<Text style={{ color: p.codeNum }}>{m[0]}</Text>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<Text style={{ color: p.text }}>{text.slice(last)}</Text>);
  return out;
}

function CopyButton(props: { text: string; label: string }) {
  const p = () => tok();
  const copied = signal(false);
  const hovered = signal(false);
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
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      accessibilityLabel={copied() ? "Copied" : `Copy ${props.label}`}
      tooltip={<TipBubble text={copied() ? "Copied" : `Copy ${props.label}`} />}
      style={{
        width: 22,
        height: 22,
        borderRadius: 5,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        transitionProperty: "colors",
        transitionDuration: ms(durations.press),
      }}
      hoverStyle={{ backgroundColor: p().subtle }}
      focusVisibleStyle={{ outlineWidth: 2, outlineColor: p().focus, outlineOffset: 2, outlineStyle: "solid" }}
    >
      {copied() ? <SurfaceIcon name="check" size={12} color={p().ok} strokeWidth={1.7} /> : <CopyIcon size={12} color={hovered() ? p().ink : p().muted} />}
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
  const danger = () => props.tone === "danger";
  const ring = () => (danger() ? dangerTint(p()).ring : p().border);
  const headBg = () => (danger() ? dangerTint(p()).fill : p().tile);
  return (
    <View
      testID={props.testID}
      style={{
        borderRadius: radius.sm,
        backgroundColor: p().canvas,
        borderWidth: 1,
        borderColor: ring(),
        overflow: "hidden",
      }}
    >
      <View
        style={{
          height: 28,
          paddingLeft: 10,
          paddingRight: 5,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          backgroundColor: headBg(),
          borderBottomWidth: 1,
          borderBottomColor: ring(),
        }}
      >
        <Text style={{ fontSize: 11, lineHeight: 14, fontWeight: "600", letterSpacing: 0.25, color: danger() ? p().danger : p().muted }}>{props.label}</Text>
        {shown().json ? <Text style={{ fontFamily: ty.mono.fontFamily, fontSize: 10, lineHeight: 14, color: p().faint }}>JSON</Text> : null}
        <View style={{ flex: 1 }} />
        <CopyButton text={shown().text} label={props.label.toLowerCase()} />
      </View>
      <View style={{ position: "relative", overflow: "hidden" }}>
        <Scroll style={{ maxHeight: maxHeight() }} scrollable={capped() && full() && height() > OPEN_MAX}>
          <Text
            onLayout={(e) => height.set(e.bounds.size.height)}
            style={{
              ...ty.code,
              fontSize: 11.5,
              lineHeight: 18,
              userSelect: "text",
              color: danger() ? p().danger : p().ink,
              paddingHorizontal: 10,
              paddingVertical: 8,
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
              height: 44,
              backgroundImage: `linear-gradient(to bottom, ${tint(p().canvas, 0)}, ${p().canvas})`,
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
          style={{
            height: 28,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 5,
            borderTopWidth: 1,
            borderTopColor: ring(),
            backgroundColor: p().tile,
            transitionProperty: "colors",
            transitionDuration: ms(durations.press),
          }}
          hoverStyle={{ backgroundColor: p().subtle }}
          focusVisibleStyle={{ outlineWidth: 2, outlineColor: p().focus, outlineOffset: -2, outlineStyle: "solid" }}
        >
          <Chevron open={full()} size={10} color={p().muted} />
          <Text style={{ fontSize: 11.5, lineHeight: 14, fontWeight: "500", color: p().ink }}>{full() ? "Show less" : "Show all"}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function ToolCallCard(props: ToolCallCardProps) {
  const p = () => tok();
  const open = signal(props.defaultOpen ?? props.call.status === "failed");
  const hovered = signal(false);
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
  const showSummary = () => props.call.summary.trim() !== "" && props.call.summary !== props.call.name;
  return (
    <View
      testID={`tool-call-${props.call.id}`}
      style={{
        borderRadius: props.nested === true ? 0 : radius.card,
        backgroundColor: props.nested === true ? "transparent" : p().surface,
        boxShadow: props.nested === true ? [] : cardShadow(p()),
        overflow: "hidden",
      }}
    >
      <View
        onPress={toggle}
        onMouseEnter={() => hovered.set(true)}
        onMouseLeave={() => hovered.set(false)}
        role="button"
        accessibilityLabel={`${props.call.name}: ${props.call.summary}`}
        accessibilityState={{ expanded: open() }}
        style={{
          minHeight: props.nested === true ? 36 : 42,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingLeft: props.nested === true ? 28 : 10,
          paddingRight: 12,
          transitionProperty: "colors",
          transitionDuration: ms(durations.press),
          transitionTimingFunction: "ease",
        }}
        hoverStyle={{ backgroundColor: p().subtle }}
        activeStyle={{ opacity: 0.9 }}
        focusVisibleStyle={{ outlineWidth: 2, outlineColor: p().focus, outlineOffset: -2, outlineStyle: "solid" }}
      >
        <Chevron open={open()} color={hovered() ? p().ink : p().muted} />
        <IconTile glyph={toolGlyph(props.call.name)} size={22} />
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            style={{
              fontFamily: ty.mono.fontFamily,
              fontSize: 12,
              lineHeight: 16,
              fontWeight: "600",
              color: p().ink,
              numberOfLines: 1,
              flexShrink: 0,
              maxWidth: 160,
            }}
          >
            {props.call.name}
          </Text>
          {showSummary() ? (
            <Text style={{ fontSize: 12.5, lineHeight: 16, color: p().muted, flex: 1, minWidth: 0, numberOfLines: 1, writingDirection: "auto" }}>
              {props.call.summary}
            </Text>
          ) : null}
        </View>
        <CallStatus status={props.call.status} startedMs={props.call.startedMs} endedMs={props.call.endedMs} />
      </View>
      {open() ? (
        <View style={{ paddingLeft: props.nested === true ? 50 : 32, paddingRight: 12, paddingBottom: 12, paddingTop: 4, gap: 10, ...body.style }}>
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
              <View style={{ paddingTop: 2 }}>
                <ErrorMark />
              </View>
              <Text style={{ fontSize: 12.5, lineHeight: 18, color: p().danger, flex: 1, numberOfLines: 4, writingDirection: "auto" }}>
                {props.call.error ?? "The tool call failed."}
              </Text>
              {props.onRetry ? (
                <Button
                  onPress={() => props.onRetry?.()}
                  accessibilityLabel="Retry tool call"
                  tooltip={<TipBubble text="Retry tool call" />}
                  style={{
                    height: 28,
                    paddingHorizontal: 10,
                    borderRadius: radius.sm,
                    backgroundColor: p().surface,
                    borderWidth: 1,
                    borderColor: p().border,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 5,
                    flexShrink: 0,
                  }}
                  hoverStyle={{ backgroundColor: p().subtle }}
                  activeStyle={{ opacity: 0.88 }}
                  focusVisibleStyle={{ outlineWidth: 2, outlineColor: p().focus, outlineOffset: 2, outlineStyle: "solid" }}
                >
                  <SurfaceIcon name="refresh" size={12} color={p().ink} />
                  <Text style={{ fontSize: 11.5, lineHeight: 14, fontWeight: "500", color: p().ink }}>Retry</Text>
                </Button>
              ) : null}
            </View>
          ) : null}
          {props.call.input != null ? <CodeSection label="Arguments" value={props.call.input} testID="arguments" /> : null}
          {props.call.output != null && props.call.output !== "" ? (
            <CodeSection label="Result" value={props.call.output} tone={props.call.status === "failed" ? "danger" : undefined} testID="result" />
          ) : props.call.status === "running" ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderRadius: radius.sm,
                backgroundColor: p().canvas,
                borderWidth: 1,
                borderColor: p().border,
              }}
            >
              <Spinner size={11} color={p().muted} />
              <Text style={{ fontSize: 12, lineHeight: 16, color: p().muted }}>Waiting for result…</Text>
            </View>
          ) : null}
          {props.call.input == null && !props.call.output && props.call.status === "done" ? (
            <Text style={{ fontSize: 12, lineHeight: 16, color: p().muted }}>No arguments or result.</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
