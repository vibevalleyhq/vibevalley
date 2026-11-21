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
import { SurfaceIcon } from "../surfaces/shared";
import { cardShadow, dangerTint, radius, tok, type as ty } from "../tokens";
import { Chevron, ErrorMark, formatMs, IconTile, Spinner, ToolCallCard, toolGlyph, useStopwatch, useSwapIn, type ToolCall } from "./ToolCallCard";

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
  const hovered = signal(false);
  const running = () => props.calls.some((c) => c.status === "running");
  const failed = () => props.calls.filter((c) => c.status === "failed").length;
  const completed = () => props.calls.filter((c) => c.status !== "running").length;
  // Counts from the earliest running call, so the group never shows less than its cards.
  const since = () => Math.min(...props.calls.filter((c) => c.status === "running").map((c) => c.startedMs));
  const live = useStopwatch(running, since);
  const total = () => props.calls.reduce((t, c) => t + Math.max(0, (c.endedMs ?? c.startedMs) - c.startedMs), 0);
  const elapsed = () => (running() ? live() : total());
  const title = () => (running() ? "Using tools…" : (props.label ?? groupLabel(props.calls)));
  const icons = () => props.calls.slice(-3);
  const swap = useSwapIn(running);
  const tint = () => dangerTint(p());

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
    <View
      style={{
        borderRadius: radius.card,
        backgroundColor: p().surface,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: p().border,
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      <Text testID="tool-call-group-empty" style={{ fontSize: 12.5, lineHeight: 18, color: p().muted }}>
        Tool calls from this run will appear here.
      </Text>
    </View>
  );
  return (
    <If when={props.calls.length > 0} else={empty}>
      <View testID="tool-call-group" style={{ borderRadius: radius.card, backgroundColor: p().surface, boxShadow: cardShadow(p()), overflow: "hidden" }}>
        <View
          onPress={toggle}
          onMouseEnter={() => hovered.set(true)}
          onMouseLeave={() => hovered.set(false)}
          role="button"
          accessibilityLabel={`${title()}${failed() > 0 ? `, ${failed()} failed` : ""}`}
          accessibilityState={{ expanded: open() }}
          style={{
            minHeight: 42,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingLeft: 10,
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
          <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 0 }}>
            <Each of={icons()} key="index">
              {(call, i) => (
                <View style={{ marginLeft: i() === 0 ? 0 : -10, zIndex: 3 - i(), borderRadius: 7, borderWidth: 1, borderColor: p().surface }}>
                  <IconTile glyph={toolGlyph(call().name)} size={22} />
                </View>
              )}
            </Each>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0, ...swap.style }}>
            <Text
              style={{ fontSize: 13, lineHeight: 16, fontWeight: "500", color: p().ink, numberOfLines: 1, flexShrink: 1, ...(running() ? shine.style : {}) }}
            >
              {title()}
            </Text>
            {running() ? (
              <View
                style={{
                  height: 18,
                  paddingHorizontal: 6,
                  borderRadius: 999,
                  backgroundColor: p().tile,
                  borderWidth: 1,
                  borderColor: p().border,
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Text style={{ fontFamily: ty.mono.fontFamily, fontSize: 10.5, lineHeight: 14, color: p().muted, fontVariant: ["tabular-nums"] }}>
                  {`${completed()}/${props.calls.length}`}
                </Text>
              </View>
            ) : null}
            {failed() > 0 ? (
              <View
                style={{
                  height: 18,
                  paddingHorizontal: 6,
                  borderRadius: 999,
                  backgroundColor: tint().fill,
                  borderWidth: 1,
                  borderColor: tint().ring,
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Text style={{ fontSize: 11, lineHeight: 14, fontWeight: "500", color: p().danger, fontVariant: ["tabular-nums"] }}>
                  {`${failed().toLocaleString()} failed`}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              {running() ? <Spinner /> : failed() > 0 ? <ErrorMark /> : <SurfaceIcon name="check" size={12} color={p().ok} strokeWidth={1.7} />}
            </View>
            <Text style={{ fontFamily: ty.mono.fontFamily, fontSize: 11.5, lineHeight: 16, color: p().muted, fontVariant: ["tabular-nums"] }}>
              {formatMs(elapsed(), running())}
            </Text>
          </View>
        </View>
        {open() ? (
          <View style={{ borderTopWidth: 1, borderTopColor: p().border, position: "relative" }}>
            <View
              accessibilityElementsHidden
              style={{
                position: "absolute",
                left: 17,
                top: 0,
                bottom: 0,
                width: 1,
                backgroundColor: p().border,
              }}
            />
            <Each of={props.calls} key={(c) => c.id}>
              {(call, i) => (
                <View>
                  {i() > 0 ? <View style={{ marginLeft: 28, height: 1, backgroundColor: p().border }} /> : null}
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
