// RadioGroup and Radio (Base UI's): one value out of several. The group is one tab stop (the checked radio, else the
// first enabled); the arrow keys move to the next radio and check it, as a native radio group does.

import { createContext, createSignal, omit, Show, useContext } from "solid-js";
import { itemsIn, roveFocus } from "./internal/roving";
import { type ButtonProps, call, createControllable, type DivProps, flag, refs, type SpanProps } from "./internal/state";

interface GroupCtx {
  readonly value: () => string | undefined;
  readonly check: (value: string) => void;
  readonly disabled: () => boolean;
  readonly readOnly: () => boolean;
  readonly tabStop: () => string | undefined;
}

const GroupContext = createContext<GroupCtx>();

export interface RadioGroupProps extends DivProps {
  value?: string | undefined;
  defaultValue?: string | undefined;
  onValueChange?: ((value: string) => void) | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  /** Sent with a form under this name. */
  name?: string | undefined;
}

const radio = "[role=radio]";

export function RadioGroup(props: RadioGroupProps) {
  const rest = omit(props, "value", "defaultValue", "onValueChange", "disabled", "readOnly", "name", "ref", "onKeyDown", "children");
  const [value, setValue] = createControllable<string | undefined>({
    value: () => props.value,
    initial: props.defaultValue,
    onChange: (v) => v !== undefined && props.onValueChange?.(v),
  });
  const [first, setFirst] = createSignal<string>();
  let root: HTMLDivElement | undefined;
  const ctx: GroupCtx = {
    value,
    check: (v) => {
      if (!props.readOnly) setValue(v);
    },
    disabled: () => Boolean(props.disabled),
    readOnly: () => Boolean(props.readOnly),
    tabStop: () => value() ?? first(),
  };
  return (
    <GroupContext value={ctx}>
      <div
        role="radiogroup"
        {...rest}
        ref={refs(props.ref, (el: HTMLDivElement) => {
          root = el;
          queueMicrotask(() => setFirst(itemsIn(el, `${radio}:not([data-disabled])`)[0]?.dataset.value));
        })}
        aria-disabled={props.disabled ? "true" : undefined}
        aria-readonly={props.readOnly ? "true" : undefined}
        data-disabled={flag(props.disabled)}
        onKeyDown={(e) => {
          call(props.onKeyDown, e);
          if (!root || e.defaultPrevented) return;
          const to = roveFocus(e, root, radio, { orientation: "both", loop: true });
          if (to?.dataset.value !== undefined) ctx.check(to.dataset.value);
        }}
      >
        {props.children}
        <Show when={props.name}>{(name) => <input type="hidden" name={name()} value={value() ?? ""} />}</Show>
      </div>
    </GroupContext>
  );
}

const RadioContext = createContext<() => boolean>(() => false);

export interface RadioRootProps extends ButtonProps {
  value: string;
}

function Root(props: RadioRootProps) {
  const g = useContext(GroupContext);
  const rest = omit(props, "value", "onClick", "children");
  const checked = () => g.value() === props.value;
  const disabled = () => Boolean(props.disabled) || g.disabled();
  return (
    <button
      type="button"
      role="radio"
      {...rest}
      disabled={disabled()}
      aria-checked={checked() ? "true" : "false"}
      tabindex={g.tabStop() === props.value ? 0 : -1}
      data-value={props.value}
      data-checked={flag(checked())}
      data-unchecked={flag(!checked())}
      data-disabled={flag(disabled())}
      data-readonly={flag(g.readOnly())}
      onClick={(e) => {
        call(props.onClick, e);
        if (!e.defaultPrevented) g.check(props.value);
      }}
    >
      <RadioContext value={checked}>{props.children}</RadioContext>
    </button>
  );
}

/** Shown only while its radio is checked, unless keepMounted. */
function Indicator(props: SpanProps & { keepMounted?: boolean | undefined }) {
  const checked = useContext(RadioContext);
  const rest = omit(props, "keepMounted");
  return (
    <Show when={checked() || props.keepMounted}>
      <span aria-hidden="true" {...rest} data-checked={flag(checked())} data-unchecked={flag(!checked())} />
    </Show>
  );
}

export const Radio = { Root, Indicator };
