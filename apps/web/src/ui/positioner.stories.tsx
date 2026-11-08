import * as stylex from "@stylexjs/stylex";
import { createSignal } from "solid-js";

import { Popover } from "@vibevalley/base-ui";
import { stories, story } from "@vibevalley/stories";

import { positionerAttrs } from "./positioner";

const styles = stylex.create({
  frame: (backgroundColor: string) => ({ backgroundColor, color: "var(--color-ink)" }),
  trigger: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--color-line)",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-page)",
    color: "var(--color-ink)",
    paddingInline: "0.625rem",
    paddingBlock: "0.375rem",
  },
  active: { backgroundColor: "var(--color-selected)" },
  width: (width: number) => ({ width }),
  popup: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--color-line)",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--color-page)",
    color: "var(--color-ink)",
    padding: "0.75rem",
    boxShadow: "var(--shadow-float)",
  },
});

function Positioned() {
  const [wide, setWide] = createSignal(false);
  const [trigger, setTrigger] = createSignal<HTMLElement>();
  return (
    <Popover.Root>
      <Popover.Trigger
        ref={setTrigger}
        data-testid="stylex-trigger"
        data-ref-forwarded={trigger() === undefined ? "false" : "true"}
        {...stylex.attrs(styles.trigger, wide() && styles.active)}
      >
        Open
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner data-testid="stylex-positioner" sideOffset={6} {...positionerAttrs(styles.width(wide() ? 280 : 200))}>
          <Popover.Popup data-testid="stylex-popup" {...stylex.attrs(styles.popup)}>
            <button
              type="button"
              data-testid="stylex-resize"
              data-wide={wide() ? "true" : "false"}
              {...stylex.attrs(styles.trigger)}
              onClick={() => setWide((value) => !value)}
            >
              Resize
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default stories({
  title: "组件/工作台/Positioner",
  frame: styles.frame("var(--color-page)"),
  stories: { Dynamic: story({ render: () => <Positioned /> }) },
});
