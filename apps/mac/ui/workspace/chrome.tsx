import { signal, Text, View, type JSX, type TextStyle } from "nsh";
import { Button } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "../design/Icon";
import type { IconName } from "../design/icons";
import { motionClass } from "../design/motion";
import { Bubble } from "../design/Tip";
import { mix } from "../design/tone";

export const menuPopupClass = "min-w-44 gap-0.5 rounded-lg border border-line bg-elevated p-1 shadow-float";
export const menuItemClass = "h-7 justify-center rounded-md px-2.5 hover:bg-hover focus:bg-hover";
export const menuDangerItemClass = "h-7 justify-center rounded-md px-2.5 hover:bg-bad-soft focus:bg-bad-soft";
export const menuSeparatorClass = "my-1 h-px bg-line";

export const startEllipsis: TextStyle = { textOverflow: "ellipsis-start" };

export function gitToneTextClass(tone: string | undefined): string {
  switch (tone) {
    case "modified":
    case "dirty":
      return "text-warn-ink";
    case "added":
    case "untracked":
      return "text-leaf";
    case "deleted":
    case "conflicted":
      return "text-berry";
    case "ignored":
    case "placeholder":
      return "text-faint";
    default:
      return "text-ink";
  }
}

export function gitToneIconTone(tone: string | undefined): string {
  switch (tone) {
    case "modified":
    case "dirty":
      return "warn-ink";
    case "added":
    case "untracked":
      return "leaf";
    case "deleted":
    case "conflicted":
      return "berry";
    case "ignored":
    case "placeholder":
      return "faint";
    default:
      return "ink";
  }
}

function SectionCountBadge(props: { count: number; tone?: "default" | "danger" | "alert" | undefined }) {
  const pillClass = () => {
    if (props.tone === "danger") return "bg-bad-soft";
    if (props.tone === "alert") return "bg-warn-soft";
    return "bg-hover";
  };
  const borderStyle = () => {
    if (props.tone === "danger") return { borderColor: mix("berry", 0.25) };
    if (props.tone === "alert") return { borderColor: mix("wheat", 0.25) };
    return undefined;
  };
  const textClass = () => {
    if (props.tone === "danger") return "text-berry";
    if (props.tone === "alert") return "text-warn-ink";
    return "text-muted";
  };
  return (
    <View
      class={`h-4 min-w-4.5 shrink-0 items-center justify-center rounded-full border px-1.5 ${props.tone === "danger" || props.tone === "alert" ? "" : "border-transparent"} ${pillClass()}`}
      style={borderStyle()}
    >
      <Text class={`font-mono text-2xs font-medium ${textClass()}`}>{props.count.toLocaleString()}</Text>
    </View>
  );
}

export function SectionHead(props: {
  title: string;
  count?: number;
  right?: JSX.Element;
  collapsible?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  tone?: "default" | "danger" | "alert";
  borderTop?: boolean;
  borderBottom?: boolean;
}) {
  const hovered = signal(false);
  const open = () => props.expanded !== false;
  const titleClass = () => {
    if (props.tone === "danger") return "text-berry";
    if (props.collapsible === true && hovered()) return "text-ink";
    return "text-muted";
  };
  const labelRow = () => (
    <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
      {props.collapsible === true ? (
        <View
          class={`size-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
          style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}
        >
          <Icon name="expand" size={10} tone={hovered() ? "ink" : "muted"} />
        </View>
      ) : null}
      <Text role="header" class={`truncate text-2xs font-semibold tracking-wide ${titleClass()}`}>
        {props.title}
      </Text>
      {props.count !== undefined ? <SectionCountBadge count={props.count} tone={props.tone} /> : null}
    </View>
  );

  return (
    <View
      class={`h-7.5 flex-row items-center gap-1.5 pr-2 pl-3 ${props.borderTop === true ? "border-t border-line" : ""} ${props.borderBottom === true ? "border-b border-line" : ""}`}
    >
      {props.collapsible === true ? (
        <Button
          onPress={() => props.onToggle?.()}
          onMouseEnter={() => hovered.set(true)}
          onMouseLeave={() => hovered.set(false)}
          accessibilityLabel={open() ? t("web.shell.section.collapse", { title: props.title }) : t("web.shell.section.expand", { title: props.title })}
          class="-ml-1 h-6 min-w-0 flex-1 flex-row items-center rounded-md px-1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
        >
          {labelRow()}
        </Button>
      ) : (
        labelRow()
      )}
      {props.right !== undefined ? <View class="shrink-0 flex-row items-center gap-0.5">{props.right}</View> : null}
    </View>
  );
}

export function ShellIconButton(props: {
  label: string;
  icon: IconName;
  onPress: () => void;
  danger?: boolean;
  tone?: string;
  size?: number;
  compact?: boolean;
  disabled?: boolean;
}) {
  const hovered = signal(false);
  const iconTone = () => {
    if (props.disabled === true) return "faint";
    if (props.danger === true) return "berry";
    if (hovered()) return props.tone ?? "ink";
    return props.tone ?? "muted";
  };
  return (
    <Button
      disabled={props.disabled}
      onPress={props.onPress}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      accessibilityLabel={props.label}
      tooltip={<Bubble text={props.label} />}
      class={[
        props.compact === true ? "size-5 rounded-sm" : "size-5.5 rounded-md",
        `shrink-0 items-center justify-center ${motionClass("transition-opacity duration-120 ease-out")}`,
        props.disabled === true
          ? "opacity-50"
          : `${props.danger === true ? "hover:bg-bad-soft" : "hover:bg-selected"} active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`,
      ].join(" ")}
    >
      <Icon name={props.icon} size={props.size ?? 13} tone={iconTone()} />
    </Button>
  );
}

export function PanelEmpty(props: { text: string; compact?: boolean }) {
  return <Text class={`px-3 text-xs leading-relaxed text-muted ${props.compact === true ? "py-1.5" : "py-2.5"}`}>{props.text}</Text>;
}
