// StatusBadge: a stage or session phase as a small pill: a soft tint with
// matching text, a leading dot that pulses while something runs.
// Ported from affectUI's Badge (free).
//
// affectUI is MIT licensed: Copyright (c) affectUI contributors. Permission
// is hereby granted, free of charge, to any person obtaining a copy of this
// software, to deal in it without restriction, provided this notice is kept.
import { colorScheme, createMotion, effect, reduceMotion, Text, View } from "nsh";

import { durations, ease, ms } from "../motion";
import { tok, type Palette } from "../tokens";

/** The spec's three status forms plus `alert` (needs you) and `idle`. */
export type Tone = "running" | "done" | "failed" | "alert" | "idle";

export type StatusBadgeProps = {
  tone: Tone;
  label: string;
  /** The dot pulses (running, live). */
  live?: boolean;
  testID?: string;
};

/** `#rrggbb` or `rgba(...)` token at `a` opacity, for tints of a token. */
function tint(color: string, a: number): string {
  if (color.startsWith("#") && color.length === 7) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return color;
}

function colors(p: Palette, tone: Tone, dark: boolean): { fg: string; bg: string; ring: string; dot: string } {
  switch (tone) {
    case "running":
      return { fg: p.ink, bg: dark ? "rgba(236,235,232,0.10)" : p.tile, ring: p.border, dot: p.ink };
    case "done":
      return { fg: p.ok, bg: tint(p.ok, dark ? 0.16 : 0.1), ring: tint(p.ok, dark ? 0.3 : 0.22), dot: p.ok };
    case "failed":
      return { fg: p.danger, bg: tint(p.danger, dark ? 0.16 : 0.09), ring: tint(p.danger, dark ? 0.32 : 0.22), dot: p.danger };
    case "alert":
      return { fg: p.alert, bg: tint(p.alert, dark ? 0.16 : 0.11), ring: tint(p.alert, dark ? 0.32 : 0.24), dot: p.alert };
    case "idle":
      return { fg: p.muted, bg: p.tile, ring: p.border, dot: p.faint };
  }
}

export function StatusBadge(props: StatusBadgeProps) {
  const c = () => colors(tok(), props.tone, colorScheme() === "dark");
  // affectUI's live dot breathes over 1.8 s; under reduced motion it stands still.
  const dot = createMotion();
  effect(() => {
    if (!props.live || reduceMotion()) return dot.reset();
    void dot.play({ duration: 1800, iterations: "infinite", keyframes: { opacity: [1, 0.32, 1], scale: [1, 0.86, 1] } });
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
        gap: 6,
        height: 22,
        maxWidth: "100%",
        paddingHorizontal: 8,
        borderRadius: 999,
        backgroundColor: c().bg,
        borderWidth: 1,
        borderColor: c().ring,
        transitionProperty: "colors",
        transitionDuration: ms(durations.statusSwap),
        transitionTimingFunction: ease,
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: c().dot,
          flexShrink: 0,
          ...(props.live ? dot.style : {}),
        }}
      />
      <Text
        style={{
          fontSize: 11,
          lineHeight: 14,
          fontWeight: "500",
          color: c().fg,
          numberOfLines: 1,
          flexShrink: 1,
          minWidth: 0,
          writingDirection: "auto",
          fontVariant: ["tabular-nums"],
        }}
      >
        {props.label}
      </Text>
    </View>
  );
}
