// Small pieces the shell surfaces share (not part of the component library).
import { Text, View, type Component } from "nsh";
import { Button } from "nsh/base";

import { pressTransition } from "../motion";
import { radius, tok, type Palette, type as ty } from "../tokens";

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

export function SectionHead(props: { title: string; count?: number; right?: ReturnType<Component> }) {
  const p = () => tok();
  return (
    <View style={{ height: 36, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 6 }}>
      <Text role="header" style={{ ...ty.label, fontWeight: "600", color: p().muted, flex: 1, numberOfLines: 1 }}>
        {props.title.toUpperCase()}
        {props.count != null ? `  ${props.count.toLocaleString()}` : ""}
      </Text>
      {props.right ?? null}
    </View>
  );
}

export function IconButton(props: { label: string; glyph: string; onPress: () => void; color?: string }) {
  const p = () => tok();
  return (
    <Button
      onPress={props.onPress}
      accessibilityLabel={props.label}
      class="hover:bg-[#f0f0f0] dark:hover:bg-[#232326] active:scale-[0.98]"
      style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center", ...pressTransition() }}
    >
      <Text style={{ fontSize: 13, color: props.color ?? p().muted }}>{props.glyph}</Text>
    </Button>
  );
}

export function Empty(props: { text: string }) {
  return <Text style={{ ...ty.body, color: tok().muted, paddingHorizontal: 12, paddingVertical: 8 }}>{props.text}</Text>;
}

export function PrimaryButton(props: { label: string; onPress: () => void; disabled?: boolean }) {
  const p = () => tok();
  return (
    <Button
      onPress={props.onPress}
      disabled={props.disabled}
      class="active:scale-[0.98] disabled:opacity-40"
      style={{
        height: 30,
        paddingHorizontal: 14,
        borderRadius: radius.button,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: p().primary,
        ...pressTransition(),
      }}
    >
      <Text style={{ ...ty.label, fontWeight: "600", color: p().onPrimary }}>{props.label}</Text>
    </Button>
  );
}
