// Ported from VibeValley apps/web/src/ui/Checkbox.tsx on nsh/base's Checkbox.
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
  const disabled = () => props.disabled === true;
  return (
    <Base
      checked={props.checked}
      indeterminate={props.indeterminate}
      disabled={props.disabled}
      hitSlop={4}
      accessibilityLabel={props.label}
      testID={props.testid}
      onChange={(e) => props.onChange(e.checked)}
      class={[
        "size-4 shrink-0 items-center justify-center rounded-xs border transition duration-120 ease-out",
        on()
          ? disabled()
            ? "border-accent bg-accent"
            : "border-accent bg-accent hover:border-accent-hover hover:bg-accent-hover"
          : disabled()
            ? "border-idle bg-page"
            : "border-idle bg-page hover:border-muted hover:bg-hover",
        disabled() ? "opacity-50" : "focus-visible:outline-2 focus-visible:outline-focus",
        props.class ?? "",
      ].join(" ")}
      indicator={
        <If when={on()}>
          <Icon name={props.indeterminate === true ? "partly" : "ticked"} size={12} tone="page" />
        </If>
      }
    />
  );
}
