import type { JSX } from "@solidjs/web";
import { createUniqueId } from "solid-js";
import { Icon } from "./Icon";

// What a page does not need to say until asked: a bubble over its anchor while the pointer or the focus is on it.

export function Tip(props: { text: string; children: JSX.Element; class?: string; id?: string }) {
  return (
    <span class={["group/tip relative inline-flex", props.class]}>
      {props.children}
      <span
        id={props.id}
        role="tooltip"
        class="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 hidden animate-fade-in w-max max-w-72 -translate-x-1/2 rounded-md bg-ink px-2 py-1 text-xs leading-snug font-normal whitespace-normal text-page shadow-float group-focus-within/tip:block group-hover/tip:block"
      >
        {props.text}
      </span>
    </span>
  );
}

/** An info icon that says `text` on hover or focus; it describes, it does not label (a field's label stays its own). */
export function Hint(props: { text: string }) {
  const id = createUniqueId();
  return (
    <Tip text={props.text} id={id}>
      <span
        tabindex={0}
        aria-describedby={id}
        class="inline-flex cursor-help rounded text-faint outline-none hover:text-muted focus-visible:outline-2 focus-visible:outline-focus"
      >
        <Icon name="info" size={14} />
      </span>
    </Tip>
  );
}
