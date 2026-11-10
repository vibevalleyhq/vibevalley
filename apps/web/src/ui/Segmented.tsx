import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, Show, untrack } from "solid-js";

import { Toggle, ToggleGroup } from "@vibevalley/base-ui";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { styleProps } from "./positioner";

const styles = stylex.create({
  track: {
    position: "relative",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 0.5)",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-hover)",
    padding: "calc(var(--spacing) * 0.5)",
  },
  block: { display: "flex", width: "100%" },
  fitted: { display: "inline-flex", width: "fit-content" },
  thumb: {
    pointerEvents: "none",
    position: "absolute",
    top: 0,
    left: 0,
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-page)",
    boxShadow: "var(--shadow-raise)",
  },
  place: (x: number, y: number, width: number, height: number) => ({ translate: `${x}px ${y}px`, width, height }),
  moved: { transitionProperty: "translate, width", transitionDuration: "280ms", transitionTimingFunction: "var(--default-transition-timing-function)" },
  option: {
    position: "relative",
    display: "inline-flex",
    height: "calc(var(--spacing) * 6)",
    cursor: { default: "pointer", ":disabled": "default" },
    alignItems: "center",
    justifyContent: "center",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "var(--radius-sm)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    whiteSpace: "nowrap",
    transitionProperty: "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
    transitionDuration: "120ms",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    opacity: { default: null, ":disabled": 0.5 },
  },
  stretched: { flex: 1 },
  selected: { fontWeight: "var(--font-weight-medium)", color: "var(--color-ink)" },
  idle: { color: { default: "var(--color-muted)", "@media (hover: hover)": { default: null, ":hover": "var(--color-ink)" } } },
});

interface Place {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Two to five choices, one of them taken: a thumb on the page colour slides under the taken one. */
export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string; icon?: IconName | undefined; disabled?: boolean | undefined; title?: string | undefined }[];
  onChange: (v: T) => void;
  label: string;
  block?: boolean;
  testid?: string;
}) {
  // A signal: the group's element comes from ToggleGroup, which may make it after this component settles.
  const [track, setTrack] = createSignal<HTMLDivElement>();
  const [thumb, setThumb] = createSignal<Place>();
  // The first place is taken where it is; only a change of choice slides.
  const [moved, setMoved] = createSignal(false);
  const place = () => {
    // Run from effects and observers, never to follow the track: what it reads is read now.
    const on = untrack(track)?.querySelector<HTMLElement>('button[aria-pressed="true"]');
    setThumb(on ? { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight } : undefined);
  };
  createEffect(
    () => props.value,
    (_value, was) => {
      if (was !== undefined) setMoved(true);
      // After the pressed button has its aria-pressed: read where it is once the page has it.
      queueMicrotask(place);
    },
  );
  createEffect(track, (el) => {
    if (!el) return;
    place();
    // A label that changes width (the language, the interface size) moves the choice under the thumb.
    const watch = new ResizeObserver(place);
    watch.observe(el);
    return () => watch.disconnect();
  });
  return (
    <ToggleGroup
      ref={setTrack}
      value={[props.value]}
      // Pressing the taken choice again would leave none: one is always taken.
      onValueChange={(v) => {
        const option = props.options.find((o) => o.value === v[0]);
        if (option) props.onChange(option.value);
      }}
      aria-label={props.label}
      data-testid={props.testid}
      {...stylex.attrs(styles.track, props.block === true ? styles.block : styles.fitted)}
    >
      <Show when={thumb()}>
        {(at) => <span aria-hidden="true" {...styleProps([styles.thumb, moved() && styles.moved, styles.place(at().x, at().y, at().w, at().h)])} />}
      </Show>
      <For each={props.options}>
        {(o) => (
          <Toggle
            value={o.value}
            data-key={o.value}
            disabled={o.disabled}
            title={o.title}
            {...stylex.attrs(styles.option, props.block === true && styles.stretched, o.value === props.value ? styles.selected : styles.idle)}
          >
            <Show when={o.icon}>{(name) => <Icon name={name()} size={14} />}</Show>
            {o.label}
          </Toggle>
        )}
      </For>
    </ToggleGroup>
  );
}
