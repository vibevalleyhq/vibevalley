import { createEffect, createSignal, For, Show, untrack } from "solid-js";

import { Toggle, ToggleGroup } from "@vibevalley/base-ui";

import { Icon } from "./Icon";
import type { IconName } from "./icons";

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
      class={["relative flex-wrap gap-0.5 rounded-md bg-hover p-0.5", props.block === true ? "flex w-full" : "inline-flex w-fit"]}
    >
      <Show when={thumb()}>
        {(at) => (
          <span
            aria-hidden="true"
            class={[
              "pointer-events-none absolute top-0 left-0 rounded-sm bg-page shadow-raise",
              moved() && "transition-[translate,width] duration-280 ease-out",
            ]}
            style={{ translate: `${at().x}px ${at().y}px`, width: `${at().w}px`, height: `${at().h}px` }}
          />
        )}
      </Show>
      <For each={props.options}>
        {(o) => (
          <Toggle
            value={o.value}
            data-key={o.value}
            disabled={o.disabled}
            title={o.title}
            class={[
              "relative inline-flex h-6 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2.5 text-sm whitespace-nowrap transition-[color,background-color,border-color] duration-120 ease-out disabled:cursor-default disabled:opacity-50",
              props.block === true && "flex-1",
              o.value === props.value ? "font-medium text-ink" : "text-muted hover:text-ink",
            ]}
          >
            <Show when={o.icon}>{(name) => <Icon name={name()} size={14} />}</Show>
            {o.label}
          </Toggle>
        )}
      </For>
    </ToggleGroup>
  );
}
