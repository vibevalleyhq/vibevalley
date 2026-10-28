// Switch: on or off at once, no form submit needed (Base UI's Switch). A button with role switch and aria-checked; the
// thumb carries the same state for styling.

import { createContext, omit, useContext } from "solid-js";
import { type ButtonProps, call, createControllable, flag, type SpanProps } from "./internal/state";

const Context = createContext<{ readonly checked: () => boolean; readonly disabled: () => boolean }>();

const checkedAttrs = (checked: boolean, disabled: boolean) => ({
  "data-checked": flag(checked),
  "data-unchecked": flag(!checked),
  "data-disabled": flag(disabled),
});

export interface SwitchRootProps extends Omit<ButtonProps, "onChange"> {
  checked?: boolean | undefined;
  defaultChecked?: boolean | undefined;
  onCheckedChange?: ((checked: boolean) => void) | undefined;
  /** Seen but not changed (the focus still reaches it). */
  readOnly?: boolean | undefined;
}

function Root(props: SwitchRootProps) {
  const rest = omit(props, "checked", "defaultChecked", "onCheckedChange", "readOnly", "onClick", "children");
  const [checked, setChecked] = createControllable({
    value: () => props.checked,
    initial: props.defaultChecked ?? false,
    onChange: (v) => props.onCheckedChange?.(v),
  });
  const disabled = () => Boolean(props.disabled);
  return (
    <Context value={{ checked, disabled }}>
      <button
        type="button"
        role="switch"
        {...rest}
        aria-checked={checked() ? "true" : "false"}
        aria-readonly={props.readOnly ? "true" : undefined}
        {...checkedAttrs(checked(), disabled())}
        onClick={(e) => {
          call(props.onClick, e);
          if (!e.defaultPrevented && !props.readOnly) setChecked(!checked());
        }}
      >
        {props.children}
      </button>
    </Context>
  );
}

function Thumb(props: SpanProps) {
  const c = useContext(Context);
  if (!c) throw new Error("Switch.Thumb belongs inside Switch.Root");
  return <span aria-hidden="true" {...props} {...checkedAttrs(c.checked(), c.disabled())} />;
}

export const Switch = { Root, Thumb };
