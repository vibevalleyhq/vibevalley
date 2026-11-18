// Ported from VibeValley apps/web/src/ui/Field.tsx: inputs are nsh/base's
// native Input, the select is nsh/base's Select (headless, as base-ui's)
// with VibeValley's trigger, popup and rows.
import { Text, View, type InputRef, type JSX } from "nsh";
import { Input, Select as Base } from "nsh/base";

import { Icon } from "./Icon";
import { Hint } from "./Tip";
import { mix } from "./tone";

const box = "rounded-md border border-line bg-page px-2.5 py-1.5 placeholder:text-faint focus:border-focus text-ink";

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
      class={[box, props.wide !== false ? "w-full" : "", props.text === "lg" ? "text-lg font-semibold" : "text-sm", "h-8", props.class ?? ""].join(" ")}
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
      class={[box, props.wide !== false ? "w-full" : "", props.text === "lg" ? "text-lg font-semibold" : "text-sm", props.class ?? ""].join(" ")}
    />
  );
}

/** A label over its control; what it means is behind an info icon beside the label. */
export function Field(props: { label: string; hint?: string | undefined; children: JSX.Element }) {
  return (
    <View class="gap-1">
      <View class="flex-row items-center gap-1.5">
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
  const textClass = () => (props.text === "xs" ? "text-xs" : "text-sm");
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
      popupClass="max-h-72 rounded-lg border border-line bg-page p-1 shadow-float"
      itemClass={`h-7 rounded-md px-2 ${textClass()} text-ink focus:bg-hover selected:font-medium disabled:opacity-50`}
      class={props.class}
      trigger={
        <View
          class={[
            "min-w-0 flex-row items-center gap-1.5 rounded-md border",
            props.size === "control" ? "h-7 px-2" : "h-8 px-2.5",
            props.quiet === true ? "border-transparent hover:border-line hover:bg-page" : tinted() ? "" : "border-line bg-page hover:bg-hover",
            props.disabled === true ? "opacity-50" : "",
          ].join(" ")}
          style={tinted() ? { borderColor: mix("accent", 0.4), backgroundColor: mix("accent", 0.08) } : undefined}
        >
          <Text class={`truncate min-w-0 flex-1 ${textClass()} ${props.value === "" ? "text-faint" : "text-ink"}`}>{shown()}</Text>
          <Icon name="choose" size={12} tone="muted" />
        </View>
      }
    />
  );
}
