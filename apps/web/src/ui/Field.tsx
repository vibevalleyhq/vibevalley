import { For, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useSelectValue } from "../app/util";

const box = "w-full rounded-md border border-line bg-page px-2.5 py-1.5 text-sm outline-none placeholder:text-faint focus:border-focus";

export function TextInput(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  const rest = omit(props, "class");
  return <input {...rest} class={[box, "h-8", props.class]} />;
}

export function TextArea(props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const rest = omit(props, "class");
  return <textarea {...rest} class={[box, "resize-y", props.class]} />;
}

/** A label over its control. */
export function Field(props: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <label class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted">{props.label}</span>
      {props.children}
      {props.hint && <span class="text-xs text-faint">{props.hint}</span>}
    </label>
  );
}

/** A plain <select>; value "" is the placeholder. */
export function Select(props: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  label: string;
  class?: string;
}) {
  const ref = useSelectValue(
    () => props.value,
    () => props.options,
  );
  return (
    <select
      ref={ref}
      aria-label={props.label}
      value={props.value}
      onChange={(e) => props.onChange(e.currentTarget.value)}
      class={[box, "h-8 cursor-pointer", props.class]}
    >
      {props.placeholder !== undefined && <option value="">{props.placeholder}</option>}
      <For each={props.options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
    </select>
  );
}
