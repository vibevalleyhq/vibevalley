// Progress and Meter (Base UI's): a value within a range, read out as a progress bar (a task going) or a meter (a
// level, a quota). Progress with a null value is indeterminate. The indicator carries its share as a width (or height)
// percentage, the value part says it in words; a Label names the root.

import type { JSX } from "@solidjs/web";
import { createContext, createUniqueId, omit, onSettled, createSignal, Show, useContext } from "solid-js";
import { type DivProps, flag, type SpanProps } from "./internal/state";

interface Ctx {
  readonly value: () => number | null;
  readonly min: () => number;
  readonly max: () => number;
  readonly share: () => number;
  readonly text: () => string;
  readonly attrs: () => Record<string, string | undefined>;
  readonly labelId: string;
  readonly setLabelled: (on: boolean) => void;
}

const Context = createContext<Ctx>();
const use = () => useContext(Context);

export interface RangeRootProps extends Omit<DivProps, "children"> {
  value: number | null;
  min?: number | undefined;
  max?: number | undefined;
  /** What a screen reader says for the value; a percentage by default. */
  getValueText?: ((value: number | null, share: number) => string) | undefined;
  children?: JSX.Element;
}

const makeRoot = (role: "progressbar" | "meter") =>
  function Root(props: RangeRootProps) {
    const rest = omit(props, "value", "min", "max", "getValueText", "children");
    const [labelled, setLabelled] = createSignal(false);
    const min = () => props.min ?? 0;
    const max = () => props.max ?? 100;
    const share = () => (props.value === null ? 0 : Math.min(1, Math.max(0, (props.value - min()) / (max() - min() || 1))));
    const text = () => props.getValueText?.(props.value, share()) ?? (props.value === null ? "" : `${Math.round(share() * 100)}%`);
    const attrs = () =>
      role === "progressbar"
        ? {
            "data-indeterminate": flag(props.value === null),
            "data-progressing": flag(props.value !== null && share() < 1),
            "data-complete": flag(props.value !== null && share() >= 1),
          }
        : {};
    const ctx: Ctx = { value: () => props.value, min, max, share, text, attrs, labelId: createUniqueId(), setLabelled };
    return (
      <Context value={ctx}>
        <div
          role={role}
          {...rest}
          aria-valuemin={min()}
          aria-valuemax={max()}
          aria-valuenow={props.value ?? undefined}
          aria-valuetext={text() || undefined}
          aria-labelledby={labelled() ? ctx.labelId : props["aria-labelledby"]}
          {...attrs()}
        >
          {props.children}
        </div>
      </Context>
    );
  };

function Track(props: DivProps) {
  const c = use();
  return <div {...props} {...c.attrs()} />;
}

function Indicator(props: DivProps & { orientation?: "horizontal" | "vertical" | undefined }) {
  const c = use();
  const rest = omit(props, "orientation", "style");
  return (
    <Show when={c.value() !== null}>
      <div
        {...rest}
        {...c.attrs()}
        style={{
          ...(typeof props.style === "object" ? props.style : {}),
          [props.orientation === "vertical" ? "height" : "width"]: `${c.share() * 100}%`,
        }}
      />
    </Show>
  );
}

/** The value in words; children may say it their own way. */
function Value(props: Omit<SpanProps, "children"> & { children?: ((text: string, value: number | null) => JSX.Element) | undefined }) {
  const c = use();
  const rest = omit(props, "children");
  return (
    <span aria-hidden="true" {...rest} {...c.attrs()}>
      {props.children ? props.children(c.text(), c.value()) : c.text()}
    </span>
  );
}

function Label(props: SpanProps) {
  const c = use();
  onSettled(() => {
    c.setLabelled(true);
    return () => c.setLabelled(false);
  });
  return <span {...props} id={c.labelId} {...c.attrs()} />;
}

export const Progress = { Root: makeRoot("progressbar"), Track, Indicator, Value, Label };
export const Meter = { Root: makeRoot("meter"), Track, Indicator, Value, Label };
