import { Checkbox as Base } from "nsh/base";

import { Icon } from "./Icon";

/** A box to tick: the same box on every system and in both themes, ticked in the accent colour. */
export function Checkbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  indeterminate?: boolean;
  disabled?: boolean;
  testid?: string;
  /** Placement only. */
  class?: string | undefined;
}) {
  const on = () => props.checked || props.indeterminate === true;
  return (
    <Base
      checked={props.checked}
      indeterminate={props.indeterminate}
      disabled={props.disabled}
      accessibilityLabel={props.label}
      testID={props.testid}
      onChange={(e) => props.onChange(e.checked)}
      class={[
        // Under the pointer the edge is muted, ticked or not.
        "size-4 shrink-0 items-center justify-center rounded-xs border",
        on() ? "border-accent bg-accent hover:border-muted" : "border-line bg-page hover:border-muted",
        props.disabled === true ? "opacity-50" : "",
        props.class ?? "",
      ].join(" ")}
      indicator={<Icon name={props.indeterminate === true ? "partly" : "ticked"} size={12} tone="page" />}
    />
  );
}
