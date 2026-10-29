import { Checkbox as Base } from "@vibevalley/base-ui";
import { omit } from "solid-js";
import { Icon } from "./Icon";

/** A box to tick (base-ui's Checkbox): the same box on every system and in both themes, ticked in the accent colour. */
export function Checkbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  indeterminate?: boolean;
  disabled?: boolean;
  testid?: string;
  /** Placement only. */
  class?: string;
  "data-key"?: string | number;
}) {
  const rest = omit(props, "checked", "onChange", "label", "indeterminate", "disabled", "testid", "class");
  return (
    <Base.Root
      {...rest}
      checked={props.checked}
      onCheckedChange={props.onChange}
      indeterminate={props.indeterminate}
      disabled={props.disabled}
      aria-label={props.label}
      data-testid={props.testid}
      class={[
        "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-xs border border-line bg-page text-page transition-colors duration-120 hover:border-muted disabled:cursor-default disabled:opacity-50 data-checked:border-accent data-checked:bg-accent data-indeterminate:border-accent data-indeterminate:bg-accent",
        props.class,
      ]}
    >
      <Base.Indicator class="flex">
        <Icon name={props.indeterminate ? "partly" : "ticked"} size={12} />
      </Base.Indicator>
    </Base.Root>
  );
}
