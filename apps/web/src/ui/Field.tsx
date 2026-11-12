import type { JSX } from "@solidjs/web";
import { For, omit } from "solid-js";

import { Select as Base } from "@vibevalley/base-ui";

import { Icon } from "./Icon";
import { Hint } from "./Tip";

const box = "rounded-md border border-line bg-page px-2.5 py-1.5 outline-none placeholder:text-faint focus:border-focus";

const looks = {
  quiet: "border-transparent bg-transparent hover:border-line hover:bg-page data-popup-open:border-line data-popup-open:bg-page",
  filter: "border-accent/40 bg-accent/8 hover:bg-accent/12",
  normal: "border-line bg-page hover:bg-hover data-popup-open:border-focus",
};

type ControlAppearance = {
  /** Placement only: margins, grow, a width when `wide` is false. */
  class?: JSX.ClassValue | undefined;
  style?: JSX.CSSProperties | undefined;
  /** true (default): as wide as its container; false: the caller's class gives the width. */
  wide?: boolean;
  /** The words' size: sm (default), or lg for a title being renamed. */
  text?: "sm" | "lg";
};
export type TextInputProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "class" | "style"> & ControlAppearance;

export function TextInput(props: TextInputProps) {
  const rest = omit(props, "class", "style", "wide", "text");
  return (
    <input
      {...rest}
      class={[box, props.wide !== false && "w-full", props.text === "lg" ? "text-lg font-semibold" : "text-sm", "h-8", props.class]}
      style={props.style}
    />
  );
}

export function TextArea(props: Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, "class" | "style"> & ControlAppearance) {
  const rest = omit(props, "class", "style", "wide", "text");
  return (
    <textarea
      {...rest}
      class={[box, props.wide !== false && "w-full", props.text === "lg" ? "text-lg font-semibold" : "text-sm", "resize-y", props.class]}
      style={props.style}
    />
  );
}

/** A label over its control; what it means is behind an info icon beside the label. */
export function Field(props: { label: string; hint?: string | undefined; children: JSX.Element }) {
  return (
    <label class="flex flex-col gap-1">
      <span class="flex items-center gap-1.5 text-xs font-medium text-muted">
        {props.label}
        {props.hint && <Hint text={props.hint} />}
      </span>
      {props.children}
    </label>
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
  class?: JSX.ClassValue | undefined;
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
  return (
    <Base.Root value={props.value} onValueChange={(v) => offered(v) && props.onChange(v)} items={all()} disabled={props.disabled}>
      <Base.Trigger
        data-testid={props.testid}
        data-value={props.value}
        data-state={props.state}
        aria-busy={props.state === "pending" ? "true" : undefined}
        aria-label={props.label}
        class={[
          "flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md border text-left outline-none disabled:cursor-default disabled:opacity-50",
          props.text === "xs" ? "text-xs" : "text-sm",
          props.size === "control" ? "h-7 px-2" : "h-8 px-2.5",
          props.quiet === true ? looks.quiet : props.filter === true && props.value !== "" ? looks.filter : looks.normal,
          props.class,
        ]}
      >
        <Base.Value class="min-w-0 flex-1 truncate" placeholder={props.placeholder} />
        <Icon name="choose" size={12} class="text-muted" />
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner class="z-30" sideOffset={4}>
          <Base.Popup class="max-h-72 min-w-(--anchor-width) origin-top animate-pop-in overflow-y-auto rounded-lg border border-line bg-page p-1 shadow-float outline-none">
            <For each={all()}>
              {(o) => (
                <Base.Item
                  value={o.value}
                  data-key={o.value}
                  disabled={o.disabled}
                  class="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-sm outline-none data-disabled:cursor-default data-disabled:opacity-50 data-highlighted:bg-hover data-selected:font-medium"
                >
                  <span class="min-w-0 flex-1 truncate">{o.label}</span>
                  <Base.ItemIndicator class="flex shrink-0 text-accent">
                    <Icon name="ticked" size={14} />
                  </Base.ItemIndicator>
                </Base.Item>
              )}
            </For>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
