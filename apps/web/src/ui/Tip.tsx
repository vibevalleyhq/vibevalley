import type { JSX } from "@solidjs/web";

import { Tooltip } from "@vibevalley/base-ui";

import { Icon } from "./Icon";
import type { IconName } from "./icons";

const delay = 300;

function Bubble(props: { text: string }) {
  return (
    <Tooltip.Portal>
      <Tooltip.Positioner class="z-30" sideOffset={6}>
        <Tooltip.Popup class="w-max max-w-72 animate-fade-in rounded-md bg-ink px-2 py-1 text-xs leading-snug font-normal whitespace-normal text-page shadow-float">
          {props.text}
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  );
}

export function Tip(props: { text: string; children: JSX.Element }) {
  return (
    <Tooltip.Root delay={delay}>
      <Tooltip.Trigger render="span" class="inline-flex">
        {props.children}
      </Tooltip.Trigger>
      <Bubble text={props.text} />
    </Tooltip.Root>
  );
}

/** An info icon that says `text` on hover or focus; it describes, it does not label (a field's label stays its own). */
/** icon: info for what a thing is; another for a fact of another kind beside it (where the settings are kept). */
export function Hint(props: { text: string; icon?: IconName }) {
  return (
    <Tooltip.Root delay={delay}>
      <Tooltip.Trigger
        render="span"
        tabindex={0}
        // A form of ten fields should not read as ten marks: help stays out of the way.
        class="inline-flex cursor-help rounded-sm text-faint opacity-50 outline-none transition-opacity duration-120 ease-out hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-focus"
      >
        <Icon name={props.icon ?? "info"} size={12} />
      </Tooltip.Trigger>
      <Bubble text={props.text} />
    </Tooltip.Root>
  );
}
