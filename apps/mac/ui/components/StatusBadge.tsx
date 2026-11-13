// StatusBadge: a stage or session phase as a small pill: a soft tint with
// matching text, a leading dot that pulses while something runs.
// Ported from affectUI's Badge (free).
//
// affectUI is MIT licensed: Copyright (c) affectUI contributors. Permission
// is hereby granted, free of charge, to any person obtaining a copy of this
// software, to deal in it without restriction, provided this notice is kept.
import { createMotion, effect, reduceMotion, Text, View } from "nsh";

import { durations, ease, ms } from "../motion";
import { tok, type Palette } from "../tokens";
import type { Phase, Stage } from "./shapes";

/** The spec's three status forms plus `alert` (needs you) and `idle`. */
export type Tone = "running" | "done" | "failed" | "alert" | "idle";

export type StatusBadgeProps = {
  tone: Tone;
  label: string;
  /** The dot pulses (running, live). */
  live?: boolean;
  testID?: string;
};

/** An issue stage as a badge tone: what the frame says, nothing worked out. */
export function stageTone(stage: Stage): Tone {
  switch (stage.state) {
    case "working":
      return "running";
    case "asking":
    case "reviewing":
      return "alert";
    case "stuck":
      return stage.stuck === "quiet" ? "alert" : "failed";
    case "done":
      return "done";
    default:
      return "idle";
  }
}

export function phaseTone(phase: Phase): Tone {
  if (phase.tag === "working") return phase.quiet_since ? "alert" : "running";
  if (phase.tag === "done") return "done";
  if (phase.tag === "failed") return "failed";
  return "idle";
}

/** `#rrggbb` or `rgba(...)` token at `a` opacity, for tints of a token. */
export function tint(color: string, a: number): string {
  if (color.startsWith("#") && color.length === 7) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return color;
}

function colors(p: Palette, tone: Tone): { fg: string; bg: string; dot: string } {
  switch (tone) {
    case "running":
      return { fg: p.ink, bg: p.subtle, dot: p.ink };
    case "done":
      return { fg: p.ok, bg: tint(p.ok, 0.1), dot: p.ok };
    case "failed":
      return { fg: p.danger, bg: tint(p.danger, 0.1), dot: p.danger };
    case "alert":
      return { fg: p.alert, bg: tint(p.alert, 0.12), dot: p.alert };
    default:
      return { fg: p.text, bg: p.subtle, dot: p.faint };
  }
}

export function StatusBadge(props: StatusBadgeProps) {
  const c = () => colors(tok(), props.tone);
  // affectUI's live dot breathes over 1.8 s; under reduced motion it stands still.
  const dot = createMotion();
  effect(() => {
    if (!props.live || reduceMotion()) return dot.reset();
    void dot.play({ duration: 1800, iterations: "infinite", keyframes: { opacity: [1, 0.35, 1] } });
  });
  return (
    <View
      testID={props.testID}
      accessible
      accessibilityLabel={props.label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: 5,
        height: 20,
        maxWidth: "100%",
        paddingHorizontal: 7,
        borderRadius: 999,
        backgroundColor: c().bg,
        transitionProperty: "colors",
        transitionDuration: ms(durations.statusSwap),
        transitionTimingFunction: ease,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c().dot, flexShrink: 0, ...(props.live ? dot.style : {}) }} />
      <Text
        style={{
          fontSize: 11,
          lineHeight: 16,
          fontWeight: "500",
          color: c().fg,
          numberOfLines: 1,
          flexShrink: 1,
          writingDirection: "auto",
          fontVariant: ["tabular-nums"],
        }}
      >
        {props.label}
      </Text>
    </View>
  );
}
