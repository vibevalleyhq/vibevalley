// Slider (Base UI's): one number in a range, picked by dragging along the control or with the keys on the thumb
// (arrows by step, Page Up and Down by ten steps, Home and End). onValueChange hears every move, onValueCommitted the
// value where a drag or a key press ends.

import type { JSX } from "@solidjs/web";
import { createContext, createSignal, omit, Show, useContext } from "solid-js";
import type { Orientation } from "./internal/composite";
import { call, createControllable, type DivProps, flag, refs, type SpanProps } from "./internal/state";

interface Ctx {
  readonly value: () => number;
  readonly share: () => number;
  readonly min: () => number;
  readonly max: () => number;
  readonly disabled: () => boolean;
  readonly orientation: () => Orientation;
  /** Sets the value on the step grid and returns it: Solid 2 reads the old value until its queue has run. */
  readonly set: (value: number) => number;
  readonly commit: (value: number) => void;
  readonly step: () => number;
  readonly thumb: () => HTMLElement | undefined;
  readonly setThumb: (el: HTMLElement) => void;
  readonly dragging: () => boolean;
  readonly setDragging: (on: boolean) => void;
}

const Context = createContext<Ctx>();
const use = () => useContext(Context);

/** The value on the step grid from min, inside the range, without float dust (0.1 + 0.2). */
export function snap(value: number, o: { min: number; max: number; step: number }) {
  const decimals = (String(o.step).split(".")[1] ?? "").length;
  const on = o.min + Math.round((value - o.min) / o.step) * o.step;
  return Number(Math.min(o.max, Math.max(o.min, on)).toFixed(decimals));
}

export interface SliderRootProps extends Omit<DivProps, "onChange"> {
  value?: number | undefined;
  defaultValue?: number | undefined;
  onValueChange?: ((value: number) => void) | undefined;
  onValueCommitted?: ((value: number) => void) | undefined;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | undefined;
  disabled?: boolean | undefined;
  orientation?: Orientation | undefined;
  /** Sent with a form under this name. */
  name?: string | undefined;
}

function Root(props: SliderRootProps) {
  const rest = omit(props, "value", "defaultValue", "onValueChange", "onValueCommitted", "min", "max", "step", "disabled", "orientation", "name", "children");
  const min = () => props.min ?? 0;
  const max = () => props.max ?? 100;
  const step = () => props.step ?? 1;
  const [value, setValue] = createControllable({ value: () => props.value, initial: props.defaultValue ?? min(), onChange: (v) => props.onValueChange?.(v) });
  const [thumb, setThumb] = createSignal<HTMLElement>();
  const [dragging, setDragging] = createSignal(false);
  const ctx: Ctx = {
    value,
    share: () => (value() - min()) / (max() - min() || 1),
    min,
    max,
    step,
    disabled: () => Boolean(props.disabled),
    orientation: () => props.orientation ?? "horizontal",
    set: (v) => {
      const next = snap(v, { min: min(), max: max(), step: step() });
      setValue(next);
      return next;
    },
    commit: (v) => props.onValueCommitted?.(v),
    thumb,
    setThumb,
    dragging,
    setDragging,
  };
  return (
    <Context value={ctx}>
      <div {...rest} data-orientation={ctx.orientation()} data-disabled={flag(ctx.disabled())} data-dragging={flag(dragging())}>
        {props.children}
        <Show when={props.name}>{(name) => <input type="hidden" name={name()} value={value()} />}</Show>
      </div>
    </Context>
  );
}

/** Where the pointer drags: a press anywhere on it moves the thumb there. */
function Control(props: DivProps) {
  const c = use();
  const rest = omit(props, "onPointerDown", "onPointerMove", "onPointerUp", "ref");
  let el: HTMLDivElement | undefined;
  let last = 0;
  const at = (e: PointerEvent) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const share = c.orientation() === "vertical" ? (r.bottom - e.clientY) / r.height : (e.clientX - r.left) / r.width;
    last = c.set(c.min() + Math.min(1, Math.max(0, share)) * (c.max() - c.min()));
  };
  return (
    <div
      {...rest}
      ref={refs(props.ref, (x: HTMLDivElement) => (el = x))}
      data-orientation={c.orientation()}
      data-disabled={flag(c.disabled())}
      data-dragging={flag(c.dragging())}
      style={{ "touch-action": "none", ...(typeof props.style === "object" ? props.style : {}) }}
      onPointerDown={(e) => {
        call(props.onPointerDown, e);
        if (e.defaultPrevented || c.disabled() || e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        c.setDragging(true);
        at(e);
        c.thumb()?.focus({ preventScroll: true });
      }}
      onPointerMove={(e) => {
        call(props.onPointerMove, e);
        if (c.dragging()) at(e);
      }}
      onPointerUp={(e) => {
        call(props.onPointerUp, e);
        if (!c.dragging()) return;
        c.setDragging(false);
        c.commit(last);
      }}
    />
  );
}

function Track(props: DivProps) {
  const c = use();
  return <div {...props} data-orientation={c.orientation()} data-disabled={flag(c.disabled())} />;
}

/** The filled part, from the start of the track to the thumb. */
function Indicator(props: DivProps) {
  const c = use();
  const rest = omit(props, "style");
  return (
    <div
      {...rest}
      data-orientation={c.orientation()}
      style={{
        ...(typeof props.style === "object" ? props.style : {}),
        ...(c.orientation() === "vertical"
          ? { position: "absolute", bottom: 0, height: `${c.share() * 100}%` }
          : { position: "absolute", left: 0, width: `${c.share() * 100}%` }),
      }}
    />
  );
}

function Thumb(props: DivProps & { getValueText?: ((value: number) => string) | undefined }) {
  const c = use();
  const rest = omit(props, "getValueText", "onKeyDown", "ref", "style");
  const keys: Record<string, (v: number) => number> = {
    ArrowRight: (v) => v + c.step(),
    ArrowUp: (v) => v + c.step(),
    ArrowLeft: (v) => v - c.step(),
    ArrowDown: (v) => v - c.step(),
    PageUp: (v) => v + c.step() * 10,
    PageDown: (v) => v - c.step() * 10,
    Home: () => c.min(),
    End: () => c.max(),
  };
  return (
    <div
      role="slider"
      tabindex={c.disabled() ? -1 : 0}
      {...rest}
      ref={refs(props.ref, c.setThumb)}
      aria-valuemin={c.min()}
      aria-valuemax={c.max()}
      aria-valuenow={c.value()}
      aria-valuetext={props.getValueText?.(c.value())}
      aria-orientation={c.orientation()}
      aria-disabled={c.disabled() ? "true" : undefined}
      data-orientation={c.orientation()}
      data-disabled={flag(c.disabled())}
      data-dragging={flag(c.dragging())}
      style={{
        ...(typeof props.style === "object" ? props.style : {}),
        position: "absolute",
        ...(c.orientation() === "vertical" ? { bottom: `${c.share() * 100}%`, translate: "0 50%" } : { left: `${c.share() * 100}%`, translate: "-50% 0" }),
      }}
      onKeyDown={(e) => {
        call(props.onKeyDown, e);
        const move = keys[e.key];
        if (e.defaultPrevented || c.disabled() || !move) return;
        e.preventDefault();
        c.commit(c.set(move(c.value())));
      }}
    />
  );
}

function Value(props: Omit<SpanProps, "children"> & { children?: ((value: number) => JSX.Element) | undefined }) {
  const c = use();
  const rest = omit(props, "children");
  return (
    <span {...rest} aria-hidden="true">
      {props.children ? props.children(c.value()) : c.value()}
    </span>
  );
}

export const Slider = { Root, Control, Track, Indicator, Thumb, Value };
