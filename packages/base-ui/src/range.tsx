// Progress and Meter (Base UI's): a value within a range, read out as a progress bar (a task going) or a meter (a
// level, a quota). Progress with a null value is indeterminate. The indicator carries its share as a width (or height)
// percentage, the value part says it in words; a Label names the root.

import type { JSX } from "@solidjs/web";
import { createContext, createUniqueId, omit, onSettled, createSignal, Show, useContext } from "solid-js";

import { type DivProps, flag, type SpanProps } from "./internal/element";

interface Ctx {
  readonly value: () => number | null;
  readonly min: () => number;
  readonly max: () => number;
  readonly share: () => number;
  readonly text: () => string;
  readonly indeterminate: () => boolean;
  readonly progressing: () => boolean;
  readonly complete: () => boolean;
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
    const share = () => (props.value === null ? 0 : Math.min(1, Math.max(0, (props.value - min()) / (max() === min() ? 1 : max() - min()))));
    const text = () => props.getValueText?.(props.value, share()) ?? (props.value === null ? "" : `${Math.round(share() * 100)}%`);
    // Only a progress bar says how far along it is; a meter is a level, not a task.
    const indeterminate = () => role === "progressbar" && props.value === null;
    const progressing = () => role === "progressbar" && props.value !== null && share() < 1;
    const complete = () => role === "progressbar" && props.value !== null && share() >= 1;
    const ctx: Ctx = { value: () => props.value, min, max, share, text, indeterminate, progressing, complete, labelId: createUniqueId(), setLabelled };
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
          data-indeterminate={flag(indeterminate())}
          data-progressing={flag(progressing())}
          data-complete={flag(complete())}
        >
          {props.children}
        </div>
      </Context>
    );
  };

function Track(props: DivProps) {
  const c = use();
  return <div {...props} data-indeterminate={flag(c.indeterminate())} data-progressing={flag(c.progressing())} data-complete={flag(c.complete())} />;
}

function Indicator(props: DivProps & { orientation?: "horizontal" | "vertical" | undefined }) {
  const c = use();
  const rest = omit(props, "orientation", "style");
  return (
    <Show when={c.value() !== null}>
      <div
        {...rest}
        data-indeterminate={flag(c.indeterminate())}
        data-progressing={flag(c.progressing())}
        data-complete={flag(c.complete())}
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
    <span aria-hidden="true" {...rest} data-indeterminate={flag(c.indeterminate())} data-progressing={flag(c.progressing())} data-complete={flag(c.complete())}>
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
  return (
    <span {...props} id={c.labelId} data-indeterminate={flag(c.indeterminate())} data-progressing={flag(c.progressing())} data-complete={flag(c.complete())} />
  );
}

export const Progress = { Root: makeRoot("progressbar"), Track, Indicator, Value, Label };
export const Meter = { Root: makeRoot("meter"), Track, Indicator, Value, Label };
