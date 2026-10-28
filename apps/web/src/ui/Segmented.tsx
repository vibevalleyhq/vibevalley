import { For } from "solid-js";
import { aria } from "../base/util";

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  block?: boolean;
}) {
  return (
    <div role="group" aria-label={props.label} class={["inline-flex flex-wrap gap-0.5 rounded-md bg-hover p-0.5", { "flex w-full": !!props.block }]}>
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            aria-pressed={aria(o.value === props.value)}
            disabled={o.disabled}
            title={o.title}
            onClick={() => props.onChange(o.value)}
            class={[
              "h-6 cursor-pointer rounded px-2.5 text-sm whitespace-nowrap transition-[background-color,color,box-shadow] duration-120 disabled:cursor-default disabled:opacity-50",
              { "flex-1": !!props.block },
              o.value === props.value ? "bg-page font-medium shadow-raise" : "text-muted hover:text-ink",
            ]}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}
