import { createEffect, createSignal, For, onSettled, Show } from "solid-js";
import { aria } from "../base/util";

interface Place {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Two to five choices, one of them taken: a thumb on the page colour slides under the taken one (docs/style/design.md,
 * 分段). */
export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  block?: boolean;
  testid?: string;
}) {
  let track!: HTMLDivElement;
  const [thumb, setThumb] = createSignal<Place>();
  // The first place is taken where it is; only a change of choice slides.
  const [moved, setMoved] = createSignal(false);
  const place = () => {
    const on = track.querySelector<HTMLElement>('button[aria-pressed="true"]');
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
  onSettled(() => {
    place();
    // A label that changes width (the language, the interface size) moves the choice under the thumb.
    const watch = new ResizeObserver(place);
    watch.observe(track);
    return () => watch.disconnect();
  });
  return (
    <div
      ref={(el) => (track = el)}
      role="group"
      aria-label={props.label}
      data-testid={props.testid}
      // w-fit: in a column (a card's body) a track would otherwise stretch to its width, the thumb small at one end.
      class={["relative flex-wrap gap-0.5 rounded-md bg-hover p-0.5", props.block ? "flex w-full" : "inline-flex w-fit"]}
    >
      <Show when={thumb()}>
        {(at) => (
          <span
            aria-hidden="true"
            class={["pointer-events-none absolute top-0 left-0 rounded-sm bg-page shadow-raise", { "transition-[translate,width] duration-280": moved() }]}
            style={{ translate: `${at().x}px ${at().y}px`, width: `${at().w}px`, height: `${at().h}px` }}
          />
        )}
      </Show>
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            data-key={o.value}
            aria-pressed={aria(o.value === props.value)}
            disabled={o.disabled}
            title={o.title}
            onClick={() => props.onChange(o.value)}
            class={[
              "relative h-6 cursor-pointer rounded-sm px-2.5 text-sm whitespace-nowrap transition-colors duration-120 disabled:cursor-default disabled:opacity-50",
              { "flex-1": !!props.block },
              o.value === props.value ? "font-medium text-ink" : "text-muted hover:text-ink",
            ]}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}
