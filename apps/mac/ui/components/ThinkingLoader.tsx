// ThinkingLoader: a session that is running with no tool call yet. A
// spinner, a label that breathes, a live timer; once done the spinner turns
// into a check and the label into "Thought for 6s".
// Ported from affectUI's Thinking Loader (free).
//
// affectUI is MIT licensed: Copyright (c) affectUI contributors. Permission
// is hereby granted, free of charge, to any person obtaining a copy of this
// software, to deal in it without restriction, provided this notice is kept.
import { cleanup, createMotion, effect, reduceMotion, signal, Text, View } from "nsh";

import { durations, ease, formatElapsed, ms } from "../motion";
import { SurfaceIcon } from "../surfaces/shared";
import { cardShadow, tok, type as ty } from "../tokens";
import type { AgentEvent } from "./shapes";

export type ThinkingLoaderProps = {
  /** When the session started thinking (ms since the epoch). */
  sinceMs: number;
  /** Set once the first tool call or text arrives: the loader settles. */
  doneMs?: number | null;
  /** The newest thinking text, shown muted after the label on one line. */
  thought?: string | null;
  label?: string;
  /** "pill": a ringed capsule; "plain": spinner and label only. */
  variant?: "pill" | "plain";
};

/**
 * What a ThinkingLoader shows for an event stream: the open turn while it
 * has neither a tool call nor text yet. `null` when nothing thinks.
 */
export function thinkingOf(events: AgentEvent[]): { sinceMs: number; doneMs: number | null; thought: string | null } | null {
  let since: number | null = null;
  let done: number | null = null;
  let thought: string | null = null;
  for (const e of events) {
    const k = e.kind;
    if (k.type === "turn_started") {
      since = e.at_ms;
      done = null;
      thought = null;
    } else if (since !== null && done === null) {
      if (k.type === "thinking_delta") thought = k.text;
      else if (k.type === "tool_call_started" || k.type === "text_delta" || k.type === "turn_finished" || k.type === "error") done = e.at_ms;
    }
  }
  return since === null ? null : { sinceMs: since, doneMs: done, thought };
}

function tookText(msElapsed: number): string {
  const s = Math.max(1, Math.round(msElapsed / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function ThinkingLoader(props: ThinkingLoaderProps) {
  const p = () => tok();
  const done = () => props.doneMs != null;
  const now = signal(Date.now());
  effect(() => {
    if (done()) return;
    const t = setInterval(() => now.set(Date.now()), durations.timerTick);
    cleanup(() => clearInterval(t));
  });
  // affectUI sweeps a shine over the running label; nsh has no gradient
  // mask, so the label breathes instead (spec section 3, nsh notes).
  const shine = createMotion();
  effect(() => {
    if (done() || reduceMotion()) return shine.reset();
    void shine.play({ duration: 1800, iterations: "infinite", keyframes: { opacity: [1, 0.45, 1] } });
  });
  // The check comes in after 80 ms (the stroke draw is a fade here).
  const check = createMotion({ initial: { opacity: 0, scale: 0.6 } });
  effect(() => {
    if (!done()) return check.reset();
    void check.play({ duration: ms(360), delay: ms(80), keyframes: { opacity: [0, 1], scale: [0.6, 1] } });
  });
  const label = () => (done() ? `Thought for ${tookText((props.doneMs ?? 0) - props.sinceMs)}` : (props.label ?? "Thinking"));
  const pill = () => (props.variant ?? "pill") === "pill";
  return (
    <View
      role={done() ? undefined : "progressbar"}
      accessible
      accessibilityLabel={label()}
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        maxWidth: "100%",
        gap: 7,
        height: pill() ? 30 : 24,
        paddingLeft: pill() ? 10 : 0,
        paddingRight: pill() ? 12 : 0,
        borderRadius: 999,
        backgroundColor: pill() ? p().surface : "transparent",
        boxShadow: pill() ? cardShadow(p()) : [],
      }}
    >
      <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        {done() ? (
          <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center", ...check.style }}>
            <SurfaceIcon name="check" size={12} color={p().ok} strokeWidth={1.7} />
          </View>
        ) : (
          <View
            style={{
              width: 12,
              height: 12,
              borderRadius: 6,
              borderWidth: 1.5,
              borderColor: p().subtle,
              borderTopColor: p().ink,
              animationName: reduceMotion() ? "none" : "spin",
              animationDuration: durations.spinner,
              animationTimingFunction: "linear",
            }}
          />
        )}
      </View>
      <Text
        style={{
          fontSize: 12.5,
          lineHeight: 16,
          fontWeight: "500",
          color: done() ? p().text : p().ink,
          numberOfLines: 1,
          flexShrink: 0,
          ...(done() ? {} : shine.style),
          transitionProperty: "colors",
          transitionDuration: ms(durations.statusSwap),
          transitionTimingFunction: ease,
        }}
      >
        {label()}
      </Text>
      {props.thought && !done() ? (
        <Text
          style={{
            fontSize: 12,
            lineHeight: 16,
            color: p().muted,
            numberOfLines: 1,
            flexShrink: 1,
            minWidth: 0,
            writingDirection: "auto",
          }}
        >
          {props.thought}
        </Text>
      ) : null}
      {done() ? null : (
        <Text
          style={{
            fontFamily: ty.mono.fontFamily,
            fontSize: 11.5,
            lineHeight: 16,
            color: p().muted,
            fontVariant: ["tabular-nums"],
            flexShrink: 0,
          }}
        >
          {formatElapsed(Math.max(0, now() - props.sinceMs))}
        </Text>
      )}
    </View>
  );
}
