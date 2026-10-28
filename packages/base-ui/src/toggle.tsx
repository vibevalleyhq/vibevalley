// Toggle and ToggleGroup (Base UI's): a button pressed or not, and a group of them sharing one value, a list of the
// pressed ones' values. In a group the arrow keys move among the toggles (one tab stop for the group); `multiple` lets
// several be pressed at once, else pressing one releases the others.

import { createContext, createSignal, omit, useContext } from "solid-js";
import { type ButtonProps, call, createControllable, type DivProps, flag, refs } from "./internal/state";
import type { Orientation } from "./internal/composite";
import { itemsIn, roveFocus } from "./internal/roving";

interface GroupCtx {
  readonly value: () => readonly string[];
  readonly press: (value: string, pressed: boolean) => void;
  readonly disabled: () => boolean;
  /** The toggle that takes the group's tab stop: the first pressed one, else the first. */
  readonly tabStop: () => string | undefined;
}

// A toggle may stand alone. Solid 2 reads an undefined context as unset and throws; null is a value: no group.
const GroupContext = createContext<GroupCtx | null>(null);

export interface ToggleProps extends ButtonProps {
  pressed?: boolean | undefined;
  defaultPressed?: boolean | undefined;
  onPressedChange?: ((pressed: boolean) => void) | undefined;
  /** In a ToggleGroup: what it adds to the group's value. */
  value?: string | undefined;
}

export function Toggle(props: ToggleProps) {
  const group = useContext(GroupContext);
  const rest = omit(props, "pressed", "defaultPressed", "onPressedChange", "value", "onClick", "onKeyDown");
  const [own, setOwn] = createControllable({ value: () => props.pressed, initial: props.defaultPressed ?? false, onChange: (v) => props.onPressedChange?.(v) });
  const pressed = () => (group && props.value !== undefined ? group.value().includes(props.value) : own());
  const disabled = () => Boolean(props.disabled) || (group?.disabled() ?? false);
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled()}
      aria-pressed={pressed() ? "true" : "false"}
      data-pressed={flag(pressed())}
      data-disabled={flag(disabled())}
      data-base-toggle=""
      data-value={props.value}
      tabindex={group ? (group.tabStop() === props.value ? 0 : -1) : props.tabindex}
      onClick={(e) => {
        call(props.onClick, e);
        if (e.defaultPrevented) return;
        if (group && props.value !== undefined) group.press(props.value, !pressed());
        else setOwn(!own());
      }}
    />
  );
}

export interface ToggleGroupProps extends DivProps {
  value?: readonly string[] | undefined;
  defaultValue?: readonly string[] | undefined;
  onValueChange?: ((value: string[]) => void) | undefined;
  /** Several may be pressed at once. */
  multiple?: boolean | undefined;
  disabled?: boolean | undefined;
  orientation?: Orientation | undefined;
  /** The arrows wrap from the last toggle to the first. */
  loop?: boolean | undefined;
}

export function ToggleGroup(props: ToggleGroupProps) {
  const rest = omit(props, "value", "defaultValue", "onValueChange", "multiple", "disabled", "orientation", "loop", "onKeyDown", "ref");
  const [value, setValue] = createControllable<readonly string[]>({
    value: () => props.value,
    initial: props.defaultValue ?? [],
    onChange: (v) => props.onValueChange?.([...v]),
  });
  let root: HTMLDivElement | undefined;
  const [first, setFirst] = createSignal<string>();
  const ctx: GroupCtx = {
    value,
    disabled: () => Boolean(props.disabled),
    press: (v, on) => setValue(on ? (props.multiple ? [...value(), v] : [v]) : value().filter((x) => x !== v)),
    tabStop: () => value().find(() => true) ?? first(),
  };
  return (
    <GroupContext value={ctx}>
      <div
        role="group"
        {...rest}
        ref={refs(props.ref, (el: HTMLDivElement) => {
          root = el;
          queueMicrotask(() => setFirst(itemsIn(el, "[data-base-toggle]")[0]?.dataset.value));
        })}
        data-orientation={props.orientation ?? "horizontal"}
        data-disabled={flag(Boolean(props.disabled))}
        onKeyDown={(e) => {
          call(props.onKeyDown, e);
          if (root && !e.defaultPrevented)
            roveFocus(e, root, "[data-base-toggle]", { orientation: props.orientation ?? "horizontal", loop: props.loop ?? true });
        }}
      />
    </GroupContext>
  );
}
