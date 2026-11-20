// ToolCallGroup: several tool calls folded into one line: up to three
// stacked icons (the newest), "Used 3 tools" ("Using tools…" while one
// runs), failures and the total time; the cards open in place below.
// Ported from affectUI's Tool Call Card (free), whose file also holds the
// group; the card's parts live in ToolCallCard.tsx.
//
// affectUI is MIT licensed: Copyright (c) affectUI contributors. Permission
// is hereby granted, free of charge, to any person obtaining a copy of this
// software, to deal in it without restriction, provided this notice is kept.
import { announce, createMotion, effect, reduceMotion, signal, Text, untracked, View } from "nsh";

import { animateLayout, durations, ms } from "../motion";
import { cardShadow, radius, tok, type as ty } from "../tokens";
import { Chevron, formatMs, IconTile, ToolCallCard, toolGlyph, useStopwatch, useSwapIn, type ToolCall } from "./ToolCallCard";

export type ToolCallGroupProps = {
  calls: ToolCall[];
  /** Label once every call is done; default "Used 3 tools". */
  label?: string;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onRetry?: (call: ToolCall) => void;
};

function groupLabel(calls: ToolCall[]): string {
  if (calls.some((c) => c.status === "running")) return "Using tools…";
  const n = calls.length;
  return `Used ${n.toLocaleString()} ${n === 1 ? "tool" : "tools"}`;
}

export function ToolCallGroup(props: ToolCallGroupProps) {
  const p = () => tok();
  const open = signal(props.defaultOpen ?? false);
  const running = () => props.calls.some((c) => c.status === "running");
  const failed = () => props.calls.filter((c) => c.status === "failed").length;
  // Counts from the earliest running call, so the group never shows less than its cards.
  const since = () => Math.min(...props.calls.filter((c) => c.status === "running").map((c) => c.startedMs));
  const live = useStopwatch(running, since);
  const total = () => props.calls.reduce((t, c) => t + Math.max(0, (c.endedMs ?? c.startedMs) - c.startedMs), 0);
  const elapsed = () => (running() ? live() : total());
  const title = () => (running() ? "Using tools…" : (props.label ?? groupLabel(props.calls)));
  const icons = () => props.calls.slice(-3);
  const swap = useSwapIn(running);

  let was = running();
  effect(() => {
    const now = running();
    untracked(() => {
      if (now === was) return;
      was = now;
      announce(now ? "Using tools…" : `${groupLabel(props.calls)}${failed() > 0 ? `, ${failed()} failed` : ""}`);
    });
  });

  // The running label breathes in place of affectUI's shine sweep.
  const shine = createMotion();
  effect(() => {
    if (!running() || reduceMotion()) return shine.reset();
    void shine.play({ duration: 1800, iterations: "infinite", keyframes: { opacity: [1, 0.45, 1] } });
  });

  const toggle = () => {
    animateLayout();
    open.set(!open());
    props.onOpenChange?.(open());
  };

  const empty = (
    <Text testID="tool-call-group-empty" style={{ ...ty.body, fontSize: 13, color: p().muted, paddingVertical: 12 }}>
      Tool calls from this run will appear here.
    </Text>
  );
  return (
    <If when={props.calls.length > 0} else={empty}>
      <View testID="tool-call-group" style={{ borderRadius: radius.card, backgroundColor: p().surface, boxShadow: cardShadow(p()), overflow: "hidden" }}>
        <View
          onPress={toggle}
          role="button"
          accessibilityLabel={`${title()}${failed() > 0 ? `, ${failed()} failed` : ""}`}
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
          <View style={{ flexDirection: "row", flexShrink: 0 }}>
            <Each of={icons()} key="index">
              {(call, i) => (
                <View style={{ marginLeft: i() === 0 ? 0 : -14, zIndex: 3 - i(), borderRadius: radius.sm + 1, borderWidth: 1, borderColor: p().surface }}>
                  <IconTile glyph={toolGlyph(call().name)} />
                </View>
              )}
            </Each>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0, ...swap.style }}>
            <Text style={{ ...ty.body, fontWeight: "500", color: p().ink, numberOfLines: 1, flexShrink: 1, ...(running() ? shine.style : {}) }}>{title()}</Text>
            {!running() && failed() > 0 ? (
              <Text style={{ ...ty.body, color: p().danger, flexShrink: 0 }}>{`· ${failed().toLocaleString()} failed`}</Text>
            ) : null}
            <Text style={{ ...ty.mono, fontSize: 12, color: p().muted, fontVariant: ["tabular-nums"], flexShrink: 0 }}>
              {`· ${formatMs(elapsed(), running())}`}
            </Text>
          </View>
          <Chevron open={open()} />
        </View>
        {open() ? (
          <View style={{ borderTopWidth: 1, borderTopColor: p().border }}>
            <Each of={props.calls} key={(c) => c.id}>
              {(call, i) => (
                <View style={{ borderTopWidth: i() === 0 ? 0 : 1, borderTopColor: p().border }}>
                  <ToolCallCard nested call={call()} onRetry={props.onRetry ? () => props.onRetry?.(call()) : undefined} />
                </View>
              )}
            </Each>
          </View>
        ) : null}
      </View>
    </If>
  );
}
