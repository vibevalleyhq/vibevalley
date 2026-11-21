// Ported from VibeValley apps/web/src/ui/Field.tsx: inputs are nsh/base's
// native Input, the select is nsh/base's Select (headless, as base-ui's)
// with VibeValley's trigger, popup and rows.
import { Text, View, type InputRef, type JSX } from "nsh";
import { Input, Select as Base } from "nsh/base";

import { Icon } from "./Icon";
import { Hint } from "./Tip";
import { mix } from "./tone";

const box = "rounded-md border border-line bg-page px-2.5 py-1.5 text-ink placeholder:text-faint transition duration-120 ease-out";

type ControlAppearance = {
  /** Placement only: margins, grow, a width when `wide` is false. */
  class?: string | undefined;
  /** true (default): as wide as its container; false: the caller's class gives the width. */
  wide?: boolean;
  /** The words' size: sm (default), or lg for a title being renamed. */
  text?: "sm" | "lg";
};

export type TextInputProps = ControlAppearance & {
  value?: string;
  placeholder?: string | undefined;
  onInput?: (value: string) => void;
  onSubmit?: (value: string) => void;
  onKeyPress?: (key: string) => void;
  masked?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  testID?: string | undefined;
  accessibilityLabel?: string | undefined;
  onFocus?: () => void;
  onBlur?: () => void;
  ref?: (node: InputRef) => void;
};

export function TextInput(props: TextInputProps) {
  return (
    <Input
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      value={props.value}
      placeholder={props.placeholder}
      masked={props.masked}
      autoFocus={props.autoFocus}
      readonly={props.disabled}
      onChange={(e) => props.onInput?.(e.value)}
      onSubmit={(e) => props.onSubmit?.(e.text)}
      onKeyPress={(e) => props.onKeyPress?.(e.key)}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      ref={props.ref}
      class={[
        box,
        props.disabled === true ? "bg-side opacity-50" : "hover:border-faint focus:border-focus",
        props.wide !== false ? "w-full" : "",
        props.text === "lg" ? "text-lg font-semibold" : "text-sm",
        "h-8",
        props.class ?? "",
      ].join(" ")}
    />
  );
}

/** `submit`: Return sends (onSubmit), Shift+Return breaks the line, as VibeValley's boxes that send on Enter. */
export function TextArea(props: TextInputProps & { rows?: number; submit?: boolean }) {
  return (
    <Input
      multiline
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      value={props.value}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      readonly={props.disabled}
      onChange={(e) => props.onInput?.(e.value)}
      onKeyPress={(e) => props.onKeyPress?.(e.key)}
      submitBehavior={props.submit === true ? "submit" : "newline"}
      onSubmit={(e) => props.onSubmit?.(e.text)}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      ref={props.ref}
      style={{ minHeight: (props.rows ?? 3) * 20 + 14 }}
      class={[
        box,
        props.disabled === true ? "bg-side opacity-50" : "hover:border-faint focus:border-focus",
        props.wide !== false ? "w-full" : "",
        props.text === "lg" ? "text-lg font-semibold" : "text-sm",
        props.class ?? "",
      ].join(" ")}
    />
  );
}

/** A label over its control; what it means is behind an info icon beside the label. */
export function Field(props: { label: string; hint?: string | undefined; children: JSX.Element }) {
  return (
    <View class="gap-1">
      <View class="min-h-4 flex-row items-center gap-1.5">
        <Text class="text-xs font-medium text-muted">{props.label}</Text>
        <If when={props.hint}>{(hint) => <Hint text={hint()} />}</If>
      </View>
      {props.children}
    </View>
  );
}

/** value "" is the placeholder, and choosing it is choosing none (a placeholder needs a value type that holds ""). */
export function Select<V extends string>(props: {
  value: V;
  onChange: (v: V) => void;
  options: readonly { value: V; label: string; disabled?: boolean | undefined }[];
  placeholder?: ("" extends V ? string : never) | undefined;
  label: string;
  /** Placement only: width, margins. */
  class?: string | undefined;
  testid?: string | undefined;
  quiet?: boolean;
  /** A filter that narrows: tinted while a value other than "" is chosen. */
  filter?: boolean;
  /** control: 28px, for a toolbar row; field (default): 32px, beside inputs. */
  size?: "control" | "field";
  /** The words' size: sm (default), or xs in a dense row. */
  text?: "sm" | "xs";
  disabled?: boolean | undefined;
  /** A choice on its way to the server (shown already) or refused (the value is the server's again). */
  state?: "pending" | "failed" | undefined;
}) {
  const all = () => [...(props.placeholder !== undefined ? [{ value: "", label: props.placeholder, disabled: false }] : []), ...props.options];
  const offered = (v: string): v is V => all().some((o) => o.value === v);
  const shown = () => all().find((o) => o.value === props.value)?.label ?? props.placeholder ?? "";
  const tinted = () => props.filter === true && props.value !== "";
  const disabled = () => props.disabled === true;
  const textClass = () => (props.text === "xs" ? "text-xs" : "text-sm");
  const triggerSurface = () => {
    if (props.state === "failed") return "border-berry bg-bad-soft";
    if (props.state === "pending" || tinted()) return "";
    if (props.quiet === true) return disabled() ? "border-transparent bg-transparent" : "border-transparent bg-transparent hover:border-line hover:bg-page";
    return disabled() ? "border-line bg-page" : "border-line bg-page hover:border-faint hover:bg-hover";
  };
  const triggerStyle = () => {
    if (props.state === "pending") return { borderColor: mix("wheat", 0.55), backgroundColor: mix("wheat", 0.1) };
    if (props.state !== "failed" && tinted()) return { borderColor: mix("accent", 0.45), backgroundColor: mix("accent", 0.1) };
    return undefined;
  };
  const labelColor = () => {
    if (props.value === "") return "text-faint";
    if (props.state === "failed") return "text-berry";
    if (props.state === "pending") return "text-warn-ink";
    if (tinted()) return "font-medium text-ok-ink";
    return "text-ink";
  };
  return (
    <Base
      testID={props.testid}
      accessibilityLabel={props.label}
      value={props.value}
      disabled={props.disabled}
      items={all().map((o) => ({ value: o.value, title: o.label, disabled: o.disabled === true }))}
      onChange={(e) => {
        const v = e.value ?? "";
        if (offered(v)) props.onChange(v);
      }}
      offset={4}
      align="start"
      popupClass="max-h-72 rounded-lg border border-line bg-elevated p-1 shadow-float transition duration-120 ease-out"
      popupStartingClass="opacity-0"
      popupEndingClass="opacity-0"
      listClass="gap-0.5"
      itemClass="group h-7 flex-row items-center gap-2 rounded-md px-2 transition duration-120 ease-out focus:bg-hover selected:bg-selected disabled:opacity-50"
      renderItem={(entry) => (
        <View class="min-w-0 flex-1 flex-row items-center gap-2">
          <Text class={`min-w-0 flex-1 truncate ${textClass()} text-ink group-selected:font-medium group-disabled:text-faint`}>{entry.title}</Text>
          <View class="size-3.5 shrink-0 items-center justify-center opacity-0 group-selected:opacity-100">
            <Icon name="ticked" size={12} tone="accent" />
          </View>
        </View>
      )}
      class={props.class}
      trigger={
        <View
          testID={props.testid ? `${props.testid}-trigger` : undefined}
          accessibilityState={{ busy: props.state === "pending", invalid: props.state === "failed" }}
          class={[
            "min-w-0 flex-row items-center gap-1.5 rounded-md border transition duration-120 ease-out",
            props.size === "control" ? "h-7 px-2" : "h-8 px-2.5",
            triggerSurface(),
            disabled() ? "opacity-50" : "aria-expanded:border-focus focus-visible:outline-2 focus-visible:outline-focus",
          ].join(" ")}
          style={triggerStyle()}
        >
          <Text class={`min-w-0 flex-1 truncate ${textClass()} ${labelColor()}`}>{shown()}</Text>
          <If when={props.state === "pending"}>
            <Icon name="wait" size={12} tone="warn-ink" />
          </If>
          <If when={props.state === "failed"}>
            <Icon name="cross" size={12} />
          </If>
          <Icon name="choose" size={12} tone={props.state === "failed" ? "berry" : tinted() ? "ok-ink" : "muted"} />
        </View>
      }
    />
  );
}
