// Small pieces the shell surfaces share (not part of the component library).
import { Canvas, colorScheme, signal, Text, View, type CanvasRenderingContext2D, type Component } from "nsh";
import { Button, Tooltip } from "nsh/base";

import { ms, pressTransition } from "../motion";
import { dangerTint, tok, type Palette, type as ty } from "../tokens";

export type SurfaceIconName =
  | "chevron-right"
  | "collapse-all"
  | "plus"
  | "minus"
  | "undo"
  | "refresh"
  | "git-branch"
  | "check"
  | "folder"
  | "file"
  | "arrow-up"
  | "arrow-down"
  | "lock";

const GLYPH_TO_ICON: Record<string, SurfaceIconName> = {
  "⊟": "collapse-all",
  "↺": "undo",
  "−": "minus",
  "-": "minus",
  "+": "plus",
  "＋": "plus",
  "›": "chevron-right",
  "⑂": "git-branch",
  "⟳": "refresh",
};

function drawSurfaceIcon(cx: CanvasRenderingContext2D, name: SurfaceIconName, size: number, color: string, strokeWidth?: number) {
  cx.scale(size / 16, size / 16);
  cx.strokeStyle = color;
  cx.fillStyle = color;
  cx.lineCap = "round";
  cx.lineJoin = "round";
  cx.lineWidth = (strokeWidth ?? (size <= 10 ? 1.35 : 1.45)) * (16 / size);

  switch (name) {
    case "chevron-right":
      cx.beginPath();
      cx.moveTo(6.25, 4.25);
      cx.lineTo(10, 8);
      cx.lineTo(6.25, 11.75);
      cx.stroke();
      break;
    case "collapse-all":
      cx.beginPath();
      cx.moveTo(4.5, 3.25);
      cx.lineTo(8, 6.5);
      cx.lineTo(11.5, 3.25);
      cx.moveTo(4.5, 12.75);
      cx.lineTo(8, 9.5);
      cx.lineTo(11.5, 12.75);
      cx.stroke();
      break;
    case "plus":
      cx.beginPath();
      cx.moveTo(8, 3.5);
      cx.lineTo(8, 12.5);
      cx.moveTo(3.5, 8);
      cx.lineTo(12.5, 8);
      cx.stroke();
      break;
    case "minus":
      cx.beginPath();
      cx.moveTo(3.75, 8);
      cx.lineTo(12.25, 8);
      cx.stroke();
      break;
    case "undo":
      cx.beginPath();
      cx.moveTo(5.75, 3.75);
      cx.lineTo(3, 6.25);
      cx.lineTo(5.75, 8.75);
      cx.moveTo(3.25, 6.25);
      cx.lineTo(9.5, 6.25);
      cx.arc(9.5, 9.375, 3.125, -Math.PI / 2, Math.PI / 2, false);
      cx.lineTo(6.25, 12.5);
      cx.stroke();
      break;
    case "refresh":
      cx.beginPath();
      cx.arc(8, 8, 4.65, Math.PI * 0.18, Math.PI * 1.76, false);
      cx.stroke();
      cx.beginPath();
      cx.moveTo(11.75, 2.4);
      cx.lineTo(11.6, 5.15);
      cx.lineTo(8.85, 5.15);
      cx.stroke();
      break;
    case "git-branch":
      cx.beginPath();
      cx.arc(5, 3.75, 1.75, 0, Math.PI * 2);
      cx.stroke();
      cx.beginPath();
      cx.arc(5, 12.25, 1.75, 0, Math.PI * 2);
      cx.stroke();
      cx.beginPath();
      cx.arc(11.25, 5.25, 1.75, 0, Math.PI * 2);
      cx.stroke();
      cx.beginPath();
      cx.moveTo(5, 5.5);
      cx.lineTo(5, 10.5);
      cx.moveTo(11.25, 7);
      cx.bezierCurveTo(11.25, 9.75, 5, 8.5, 5, 10.5);
      cx.stroke();
      break;
    case "check":
      cx.beginPath();
      cx.moveTo(3.5, 8.25);
      cx.lineTo(6.5, 11.25);
      cx.lineTo(12.5, 4.75);
      cx.stroke();
      break;
    case "folder":
      cx.beginPath();
      cx.moveTo(2.5, 4.75);
      cx.quadraticCurveTo(2.5, 3.5, 3.75, 3.5);
      cx.lineTo(6.1, 3.5);
      cx.lineTo(7.4, 5);
      cx.lineTo(12.25, 5);
      cx.quadraticCurveTo(13.5, 5, 13.5, 6.25);
      cx.lineTo(13.5, 11.25);
      cx.quadraticCurveTo(13.5, 12.5, 12.25, 12.5);
      cx.lineTo(3.75, 12.5);
      cx.quadraticCurveTo(2.5, 12.5, 2.5, 11.25);
      cx.closePath();
      cx.stroke();
      break;
    case "file":
      cx.beginPath();
      cx.moveTo(4.75, 2.5);
      cx.lineTo(9.25, 2.5);
      cx.lineTo(12.25, 5.5);
      cx.lineTo(12.25, 12.5);
      cx.quadraticCurveTo(12.25, 13.5, 11.25, 13.5);
      cx.lineTo(4.75, 13.5);
      cx.quadraticCurveTo(3.75, 13.5, 3.75, 12.5);
      cx.lineTo(3.75, 3.5);
      cx.quadraticCurveTo(3.75, 2.5, 4.75, 2.5);
      cx.closePath();
      cx.moveTo(9.25, 2.5);
      cx.lineTo(9.25, 5.5);
      cx.lineTo(12.25, 5.5);
      cx.stroke();
      break;
    case "arrow-up":
      cx.beginPath();
      cx.moveTo(8, 12.5);
      cx.lineTo(8, 3.5);
      cx.moveTo(4.75, 6.75);
      cx.lineTo(8, 3.5);
      cx.lineTo(11.25, 6.75);
      cx.stroke();
      break;
    case "arrow-down":
      cx.beginPath();
      cx.moveTo(8, 3.5);
      cx.lineTo(8, 12.5);
      cx.moveTo(4.75, 9.25);
      cx.lineTo(8, 12.5);
      cx.lineTo(11.25, 9.25);
      cx.stroke();
      break;
    case "lock":
      cx.beginPath();
      cx.moveTo(5.25, 7.5);
      cx.lineTo(10.75, 7.5);
      cx.quadraticCurveTo(12, 7.5, 12, 8.75);
      cx.lineTo(12, 11.75);
      cx.quadraticCurveTo(12, 13, 10.75, 13);
      cx.lineTo(5.25, 13);
      cx.quadraticCurveTo(4, 13, 4, 11.75);
      cx.lineTo(4, 8.75);
      cx.quadraticCurveTo(4, 7.5, 5.25, 7.5);
      cx.closePath();
      cx.moveTo(5.75, 7.5);
      cx.lineTo(5.75, 5.5);
      cx.arc(8, 5.5, 2.25, Math.PI, 0, false);
      cx.lineTo(10.25, 7.5);
      cx.stroke();
      break;
  }
}

export function SurfaceIcon(props: { name: SurfaceIconName; size?: number; color?: string; strokeWidth?: number }) {
  const size = () => props.size ?? 14;
  const color = () => props.color ?? tok().muted;
  return (
    <Canvas
      style={{ width: size(), height: size(), flexShrink: 0 }}
      draw={(cx) => {
        void colorScheme();
        drawSurfaceIcon(cx, props.name, size(), color(), props.strokeWidth);
      }}
    />
  );
}

export function TipBubble(props: { text: string }) {
  const p = () => tok();
  return (
    <Tooltip
      delay={350}
      offset={6}
      style={{
        maxWidth: 260,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: p().primary,
      }}
      class="shadow-float"
    >
      <Text style={{ fontSize: 11, lineHeight: 15, color: p().onPrimary }}>{props.text}</Text>
    </Tooltip>
  );
}

export function statusTint(p: Palette, kind: "danger" | "alert" | "ok"): { fill: string; ring: string } {
  if (kind === "danger") return dangerTint(p);
  const dark = colorScheme() === "dark";
  if (kind === "alert") {
    return dark ? { fill: "rgba(242,138,46,0.12)", ring: "rgba(242,138,46,0.28)" } : { fill: "rgba(230,115,14,0.08)", ring: "rgba(230,115,14,0.20)" };
  }
  return dark ? { fill: "rgba(65,189,116,0.12)", ring: "rgba(65,189,116,0.26)" } : { fill: "rgba(30,138,79,0.08)", ring: "rgba(30,138,79,0.20)" };
}

/** The color of a git tone ("modified", "added", ...). */
export function toneColor(p: Palette, tone: string | undefined): string {
  switch (tone) {
    case "modified":
    case "dirty":
      return p.alert;
    case "added":
    case "untracked":
      return p.ok;
    case "deleted":
    case "conflicted":
      return p.danger;
    case "ignored":
    case "placeholder":
      return p.faint;
    default:
      return p.ink;
  }
}

export function CountBadge(props: { count: number; tone?: "default" | "danger" | "alert" }) {
  const p = () => tok();
  const tint = () => (props.tone === "danger" ? statusTint(p(), "danger") : props.tone === "alert" ? statusTint(p(), "alert") : null);
  const textColor = () => (props.tone === "danger" ? p().danger : props.tone === "alert" ? p().alert : p().muted);
  return (
    <View
      style={{
        height: 16,
        minWidth: 18,
        paddingHorizontal: 5,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        backgroundColor: tint()?.fill ?? p().tile,
        borderWidth: tint() ? 1 : 0,
        borderColor: tint()?.ring ?? "transparent",
      }}
    >
      <Text style={{ fontFamily: ty.mono.fontFamily, fontSize: 11, lineHeight: 14, fontWeight: "500", color: textColor() }}>
        {props.count.toLocaleString()}
      </Text>
    </View>
  );
}

export function SectionHead(props: {
  title: string;
  count?: number;
  right?: ReturnType<Component>;
  collapsible?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  tone?: "default" | "danger" | "alert";
  borderTop?: boolean;
  borderBottom?: boolean;
}) {
  const p = () => tok();
  const hovered = signal(false);
  const open = () => props.expanded !== false;
  const titleColor = () => {
    if (props.tone === "danger") return p().danger;
    if (props.collapsible && hovered()) return p().ink;
    return p().muted;
  };
  const labelRow = () => (
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 }}>
      {props.collapsible ? (
        <View
          style={{
            width: 14,
            height: 14,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            rotate: open() ? "90deg" : "0deg",
            transitionProperty: "transform",
            transitionDuration: ms(120),
            transitionTimingFunction: "ease",
          }}
        >
          <SurfaceIcon name="chevron-right" size={10} color={hovered() ? p().ink : p().muted} />
        </View>
      ) : null}
      <Text
        role="header"
        style={{
          fontSize: 11,
          lineHeight: 16,
          fontWeight: "600",
          letterSpacing: 0.3,
          color: titleColor(),
          flexShrink: 1,
          numberOfLines: 1,
        }}
      >
        {props.title}
      </Text>
      {props.count != null ? <CountBadge count={props.count} tone={props.tone} /> : null}
    </View>
  );

  return (
    <View
      style={{
        height: 30,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: 12,
        paddingRight: 8,
        gap: 6,
        borderTopWidth: props.borderTop ? 1 : 0,
        borderTopColor: p().border,
        borderBottomWidth: props.borderBottom ? 1 : 0,
        borderBottomColor: p().border,
      }}
    >
      {props.collapsible ? (
        <Button
          onPress={() => props.onToggle?.()}
          onMouseEnter={() => hovered.set(true)}
          onMouseLeave={() => hovered.set(false)}
          accessibilityLabel={`${props.title}，${open() ? "折叠" : "展开"}`}
          style={{
            flex: 1,
            minWidth: 0,
            height: 24,
            flexDirection: "row",
            alignItems: "center",
            borderRadius: 5,
            paddingHorizontal: 4,
            marginLeft: -4,
            ...pressTransition(),
          }}
          hoverStyle={{ backgroundColor: p().tile }}
        >
          {labelRow()}
        </Button>
      ) : (
        labelRow()
      )}
      {props.right ? <View style={{ flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0 }}>{props.right}</View> : null}
    </View>
  );
}

export function IconButton(props: {
  label: string;
  icon?: SurfaceIconName;
  glyph?: string;
  onPress: () => void;
  color?: string;
  hoverColor?: string;
  size?: number;
  disabled?: boolean;
}) {
  const p = () => tok();
  const hovered = signal(false);
  const resolvedIcon = () => props.icon ?? (props.glyph ? GLYPH_TO_ICON[props.glyph] : undefined);
  const iconColor = () => {
    if (props.disabled) return p().faint;
    if (hovered()) return props.hoverColor ?? props.color ?? p().ink;
    return props.color ?? p().muted;
  };
  return (
    <Button
      disabled={props.disabled}
      onPress={props.onPress}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      accessibilityLabel={props.label}
      tooltip={<TipBubble text={props.label} />}
      class="active:scale-[0.96]"
      style={{
        width: 22,
        height: 22,
        borderRadius: 5,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        opacity: props.disabled ? 0.5 : 1,
        ...pressTransition(),
      }}
      hoverStyle={{ backgroundColor: props.disabled ? "transparent" : p().subtle }}
    >
      {resolvedIcon() ? (
        <SurfaceIcon name={resolvedIcon()!} size={props.size ?? 13} color={iconColor()} />
      ) : (
        <Text style={{ fontSize: 12, lineHeight: 16, color: iconColor() }}>{props.glyph ?? ""}</Text>
      )}
    </Button>
  );
}

export function Empty(props: { text: string; compact?: boolean }) {
  return (
    <Text
      style={{
        fontSize: 12,
        lineHeight: 18,
        color: tok().muted,
        paddingHorizontal: 12,
        paddingVertical: props.compact ? 6 : 10,
      }}
    >
      {props.text}
    </Text>
  );
}

export function PrimaryButton(props: { label: string; onPress: () => void; disabled?: boolean }) {
  const p = () => tok();
  return (
    <Button
      onPress={props.onPress}
      disabled={props.disabled}
      class={props.disabled ? "" : "active:scale-[0.98]"}
      style={{
        height: 28,
        paddingHorizontal: 12,
        borderRadius: 6,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: props.disabled ? p().tile : p().primary,
        borderWidth: props.disabled ? 1 : 0,
        borderColor: p().border,
        opacity: props.disabled ? 0.75 : 1,
        ...pressTransition(),
      }}
    >
      <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: "600", color: props.disabled ? p().muted : p().onPrimary }}>{props.label}</Text>
    </Button>
  );
}
