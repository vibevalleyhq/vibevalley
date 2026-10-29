import { Select } from "@vibevalley/base-ui";
import { For } from "solid-js";
import { Icon } from "./Icon";

/**
 * One of a few values, picked from a list under a quiet button (docs/style/design.md): the workbench's select, on Base
 * UI's (keyboard, focus, typing to jump). Not a native <select>: that one is drawn by the system, not by the workbench.
 * An option whose value is "" is the "all" or "none" of a filter.
 */
export function Choice<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  onChange: (v: T) => void;
  testid?: string;
  /** Marked as a filter that narrows: the trigger is tinted while a value other than "" is chosen. */
  filter?: boolean;
}) {
  return (
    <Select.Root value={props.value} items={props.options} onValueChange={(v) => props.onChange(v as T)}>
      <Select.Trigger
        aria-label={props.label}
        data-testid={props.testid}
        data-value={props.value}
        class={[
          "inline-flex h-7 max-w-48 cursor-pointer items-center gap-1 rounded-md border px-2 text-sm whitespace-nowrap transition-colors duration-120 hover:bg-hover focus-visible:border-focus focus-visible:outline-none data-popup-open:bg-hover",
          props.filter && props.value !== "" ? "border-accent/40 bg-accent/8 text-ink" : "border-line bg-page",
        ]}
      >
        {/* "" is a choice here (all, none), which Base UI reads as nothing chosen: its label is the placeholder. */}
        <Select.Value class="min-w-0 truncate" placeholder={props.options.find((o) => o.value === "")?.label} />
        <Icon name="expand" size={10} class="rotate-90 text-muted" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner class="z-30">
          <Select.Popup class="flex max-h-80 min-w-40 animate-pop-in flex-col gap-0.5 overflow-y-auto rounded-lg border border-line bg-page p-1 text-sm shadow-float">
            <For each={props.options}>
              {(o) => (
                <Select.Item
                  value={o.value}
                  data-key={o.value}
                  class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 outline-none data-highlighted:bg-hover data-selected:font-medium"
                >
                  <span class="min-w-0 flex-1 truncate">{o.label}</span>
                  <Select.ItemIndicator>
                    <Icon name="check" size={12} class="text-accent" />
                  </Select.ItemIndicator>
                </Select.Item>
              )}
            </For>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
