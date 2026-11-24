import { computed, openUrl, safeArea, Text, untracked, View, type JSX } from "nsh";
import { Input, TextView, type TextViewClasses } from "nsh/base";

import type { IconName } from "../../design/icons";
import { Icon } from "./Icon";
import type { MobileLayout } from "./layout";
import { mix } from "./tone";

export type ButtonTone = "primary" | "plain" | "ok" | "danger" | "quiet";
export type TagTone = "ok" | "bad" | "wait" | "info" | "neutral";

export function SafeScreen(props: {
  readonly bottomInset?: boolean;
  readonly topInset?: boolean;
  readonly leftInset?: boolean;
  readonly rightInset?: boolean;
  readonly class?: string;
  readonly testID?: string;
  readonly children?: JSX.Element;
}) {
  const paddingStyle = computed(() => {
    const insets = safeArea();
    return {
      paddingTop: props.topInset === false ? 0 : insets.top,
      paddingBottom: props.bottomInset === false ? 0 : insets.bottom,
      paddingLeft: props.leftInset === false ? 0 : insets.left,
      paddingRight: props.rightInset === false ? 0 : insets.right,
    };
  });

  return (
    <View testID={props.testID} class={`flex-1 bg-page ${props.class ?? ""}`} style={paddingStyle()}>
      {props.children}
    </View>
  );
}

export function SplitPane(props: {
  readonly layout: () => MobileLayout;
  readonly hasSelection: () => boolean;
  readonly master: () => JSX.Element;
  readonly detail: () => JSX.Element;
  readonly emptyDetail?: () => JSX.Element;
  readonly testID?: string;
}) {
  const isDual = computed(() => props.layout().mode === "dual_pane");

  return (
    <If
      when={isDual()}
      else={
        <View testID={props.testID} class="min-h-0 flex-1 bg-page">
          <If
            when={props.hasSelection()}
            else={
              <View testID="mobile-master-pane" class="min-h-0 flex-1 bg-page">
                {props.master()}
              </View>
            }
          >
            <View testID="mobile-detail-pane" class="min-h-0 flex-1 bg-page">
              {props.detail()}
            </View>
          </If>
        </View>
      }
    >
      <View testID={props.testID} class="min-h-0 flex-1 flex-row bg-page">
        <View testID="mobile-master-pane" class="min-h-0 shrink-0 border-r border-line bg-side" style={{ width: props.layout().masterWidth }}>
          {props.master()}
        </View>
        <View testID="mobile-detail-pane" class="min-h-0 min-w-0 flex-1 bg-page">
          <If when={props.hasSelection()} else={props.emptyDetail?.()}>
            {props.detail()}
          </If>
        </View>
      </View>
    </If>
  );
}

export function TopBar(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly onBack?: () => void;
  readonly backTestID?: string;
  readonly right?: JSX.Element;
  readonly testID?: string;
}) {
  return (
    <View testID={props.testID} class="min-h-12 flex-row items-center gap-2.5 border-b border-line bg-side px-3.5 py-2">
      <If when={props.onBack}>
        {(onBack) => (
          <View
            role="button"
            testID={props.backTestID ?? "topbar-back"}
            accessibilityLabel="Back"
            onPress={() => onBack()()}
            class="size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-page active:bg-hover"
          >
            <Icon name="back" size={16} tone="ink" />
          </View>
        )}
      </If>
      <View class="min-w-0 flex-1 gap-0.5">
        <Text class="truncate text-base font-semibold text-ink">{props.title}</Text>
        <If when={props.subtitle}>{(subtitle) => <Text class="truncate text-xs text-muted">{subtitle()}</Text>}</If>
      </View>
      <If when={props.right}>{(right) => <View class="shrink-0 flex-row items-center gap-2">{right()}</View>}</If>
    </View>
  );
}

export function SectionCard(props: {
  readonly class?: string;
  readonly testID?: string;
  readonly onPress?: () => void;
  readonly accessibilityLabel?: string;
  readonly children?: JSX.Element;
}) {
  return (
    <View
      testID={props.testID}
      role={props.onPress ? "button" : undefined}
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      class={`rounded-xl border border-line bg-elevated p-3.5 shadow-raise ${props.onPress ? "active:bg-hover" : ""} ${props.class ?? ""}`}
    >
      {props.children}
    </View>
  );
}

const buttonSurface: Record<ButtonTone, string> = {
  primary: "border-accent bg-accent active:bg-accent-hover",
  plain: "border-line bg-page active:bg-hover",
  ok: "border-leaf bg-ok-soft active:opacity-85",
  danger: "border-berry bg-bad-soft active:opacity-85",
  quiet: "border-transparent bg-transparent active:bg-hover",
};

const buttonTextClass: Record<ButtonTone, string> = {
  primary: "text-page font-semibold",
  plain: "text-ink font-medium",
  ok: "text-ok-ink font-semibold",
  danger: "text-berry font-semibold",
  quiet: "text-muted font-medium",
};

const buttonIconTone: Record<ButtonTone, string> = {
  primary: "page",
  plain: "ink",
  ok: "ok-ink",
  danger: "berry",
  quiet: "muted",
};

export function PillButton(props: {
  readonly label: string;
  readonly tone?: ButtonTone;
  readonly size?: "sm" | "md";
  readonly icon?: IconName;
  readonly disabled?: boolean;
  readonly class?: string;
  readonly testID?: string;
  readonly accessibilityLabel?: string;
  readonly onPress?: () => void;
}) {
  const tone = computed(() => props.tone ?? "plain");
  const small = computed(() => props.size === "sm");
  const disabled = computed(() => props.disabled === true);

  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      disabled={disabled()}
      onPress={() => {
        if (!disabled()) props.onPress?.();
      }}
      class={[
        "flex-row items-center justify-center gap-1.5 rounded-full border",
        small() ? "h-8 px-3" : "h-10 px-4",
        buttonSurface[tone()],
        disabled() ? "opacity-50" : "",
        props.class ?? "",
      ].join(" ")}
    >
      <If when={props.icon}>{(name) => <Icon name={name()} size={small() ? 14 : 16} tone={buttonIconTone[tone()]} />}</If>
      <Text class={`truncate ${small() ? "text-xs" : "text-sm"} ${buttonTextClass[tone()]}`}>{props.label}</Text>
    </View>
  );
}

const tagStyles: Record<
  TagTone,
  { readonly bgClass: string; readonly bgStyle?: () => string; readonly textClass: string; readonly iconTone: string; readonly dotClass: string }
> = {
  ok: { bgClass: "bg-ok-soft", textClass: "text-ok-ink", iconTone: "ok-ink", dotClass: "bg-leaf" },
  bad: { bgClass: "bg-bad-soft", textClass: "text-berry", iconTone: "berry", dotClass: "bg-berry" },
  wait: { bgClass: "bg-warn-soft", textClass: "text-warn-ink", iconTone: "warn-ink", dotClass: "bg-wheat" },
  info: { bgClass: "", bgStyle: () => mix("water", 0.14), textClass: "text-water", iconTone: "water", dotClass: "bg-water" },
  neutral: { bgClass: "bg-hover", textClass: "text-muted", iconTone: "muted", dotClass: "bg-idle" },
};

export function StatusTag(props: {
  readonly label: string;
  readonly tone: TagTone;
  readonly icon?: IconName;
  readonly dot?: boolean;
  readonly testID?: string;
}) {
  const look = computed(() => tagStyles[props.tone]);
  const dynamicBg = computed(() => {
    const fn = look().bgStyle;
    return fn ? { backgroundColor: fn() } : undefined;
  });

  return (
    <View testID={props.testID} class={`h-6 flex-row items-center gap-1.5 self-start rounded-full px-2.5 ${look().bgClass}`} style={dynamicBg()}>
      <If when={props.dot === true}>
        <View class={`size-2 shrink-0 rounded-full ${look().dotClass}`} />
      </If>
      <If when={props.icon}>{(name) => <Icon name={name()} size={12} tone={look().iconTone} />}</If>
      <Text class={`text-xs font-medium ${look().textClass}`}>{props.label}</Text>
    </View>
  );
}

export function EmptyPanel(props: { readonly icon: IconName; readonly message: string; readonly testID?: string }) {
  return (
    <View testID={props.testID} class="flex-1 items-center justify-center gap-3 px-6 py-12">
      <View class="size-12 items-center justify-center rounded-full border border-line bg-side">
        <Icon name={props.icon} size={20} tone="muted" />
      </View>
      <Text class="text-center text-sm text-muted">{props.message}</Text>
    </View>
  );
}

export function FieldInput(props: {
  readonly label?: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly onInput: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
  readonly multiline?: boolean;
  readonly disabled?: boolean;
  readonly testID?: string;
  readonly accessibilityLabel?: string;
  readonly class?: string;
}) {
  return (
    <View class={`gap-1.5 ${props.class ?? ""}`}>
      <If when={props.label}>{(label) => <Text class="text-xs font-medium text-muted">{label()}</Text>}</If>
      <Input
        testID={props.testID}
        accessibilityLabel={props.accessibilityLabel ?? props.label ?? props.placeholder}
        value={props.value}
        placeholder={props.placeholder}
        multiline={props.multiline}
        readonly={props.disabled}
        onChange={(e) => {
          if (e.value !== untracked(() => props.value)) props.onInput(e.value);
        }}
        onSubmit={(e) => props.onSubmit?.(e.text)}
        submitBehavior={props.multiline === true ? "newline" : "submit"}
        class={[
          "w-full rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-focus",
          props.multiline === true ? "min-h-20" : "h-10",
          props.disabled === true ? "bg-side opacity-60" : "",
        ].join(" ")}
      />
    </View>
  );
}

const MARKDOWN_CLASSES: TextViewClasses = {
  link: "text-water underline",
  strong: "font-semibold text-ink",
  blockquote: "my-1 border-l-2 border-faint py-0.5 pl-3 text-muted",
  alert: "my-1.5 rounded-md border border-line bg-side px-3 py-1.5",
  code: "rounded-sm border border-line bg-side px-1.5 py-px font-mono text-xs text-ink",
  keyboard: "rounded-xs border border-line bg-side px-1 py-px font-mono text-2xs text-ink",
  heading: "mt-1 mb-0.5 font-semibold text-ink",
  heading1: "text-base",
  heading2: "text-sm",
  heading3: "text-sm",
  heading4: "text-sm",
  heading5: "text-sm",
  heading6: "text-sm",
  paragraph: "my-0.5",
  list: "my-0.5 pl-5",
  listItem: "my-0.5 items-start",
  listMarker: "text-muted tabular-nums",
  listItemContent: "min-w-0 flex-1 gap-0",
  taskMarker: "mt-0.5 size-3.5 rounded-xs border border-faint bg-page",
  taskMarkerChecked: "border-accent bg-accent text-page",
  table: "my-2 overflow-hidden rounded-md border border-line",
  tableHead: "bg-side",
  tableRow: "border-b border-line",
  tableCell: "border border-line px-2 py-1 text-ink",
  tableHeaderCell: "bg-side font-semibold text-ink",
  rule: "my-2 border-line",
};

function openExternalLink(url: string): void {
  if (!/^https?:\/\//iu.test(url)) return;
  void openUrl(url).catch(() => undefined);
}

export function MarkdownText(props: {
  readonly text: string;
  readonly size?: "sm" | "base";
  readonly selectable?: boolean;
  readonly testID?: string;
  readonly class?: string;
}) {
  const sizeClass = computed(() => (props.size === "base" ? "text-base" : "text-sm"));
  const classes = computed<TextViewClasses>(() => ({
    ...MARKDOWN_CLASSES,
    root: `min-w-0 gap-0 text-ink ${sizeClass()} ${props.class ?? ""}`,
  }));

  return (
    <TextView
      testID={props.testID}
      markdown={props.text}
      selectable={props.selectable ?? true}
      classes={classes()}
      onLinkPress={(e) => openExternalLink(e.url)}
    />
  );
}
