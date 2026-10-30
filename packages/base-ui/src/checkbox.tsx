// Checkbox: checked, unchecked or (when told) indeterminate (Base UI's Checkbox). A button with role checkbox; the
// indicator is shown only while checked or indeterminate, unless keepMounted.

import { createContext, omit, Show, useContext } from "solid-js";
import { type ButtonProps, call, flag, type SpanProps } from "./internal/element";
import { createControllable } from "./internal/controllable";

interface Ctx {
  readonly checked: () => boolean;
  readonly indeterminate: () => boolean;
  readonly disabled: () => boolean;
}

const Context = createContext<Ctx>();

export interface CheckboxRootProps extends Omit<ButtonProps, "onChange"> {
  checked?: boolean | undefined;
  defaultChecked?: boolean | undefined;
  onCheckedChange?: ((checked: boolean) => void) | undefined;
  /** Neither checked nor unchecked (some of a group are); pressing it checks it. */
  indeterminate?: boolean | undefined;
}

function Root(props: CheckboxRootProps) {
  const rest = omit(props, "checked", "defaultChecked", "onCheckedChange", "indeterminate", "onClick", "children");
  const [checked, setChecked] = createControllable({
    value: () => props.checked,
    initial: props.defaultChecked ?? false,
    onChange: (v) => props.onCheckedChange?.(v),
  });
  const c: Ctx = { checked, indeterminate: () => props.indeterminate ?? false, disabled: () => Boolean(props.disabled) };
  return (
    <Context value={c}>
      <button
        type="button"
        role="checkbox"
        {...rest}
        aria-checked={c.indeterminate() ? "mixed" : checked() ? "true" : "false"}
        data-checked={flag(c.checked() && !c.indeterminate())}
        data-unchecked={flag(!c.checked() && !c.indeterminate())}
        data-indeterminate={flag(c.indeterminate())}
        data-disabled={flag(c.disabled())}
        onClick={(e) => {
          call(props.onClick, e);
          if (!e.defaultPrevented) setChecked(c.indeterminate() ? true : !checked());
        }}
      >
        {props.children}
      </button>
    </Context>
  );
}

function Indicator(props: SpanProps & { keepMounted?: boolean | undefined }) {
  const c = useContext(Context);
  const rest = omit(props, "keepMounted");
  return (
    <Show when={c.checked() || c.indeterminate() || props.keepMounted}>
      <span
        aria-hidden="true"
        {...rest}
        data-checked={flag(c.checked() && !c.indeterminate())}
        data-unchecked={flag(!c.checked() && !c.indeterminate())}
        data-indeterminate={flag(c.indeterminate())}
        data-disabled={flag(c.disabled())}
      />
    </Show>
  );
}

export const Checkbox = { Root, Indicator };
