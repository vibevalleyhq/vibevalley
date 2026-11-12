import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";

import { Popover } from "@vibevalley/base-ui";
import { stories, story } from "@vibevalley/stories";

const styles = {
  width: (width: number): JSX.CSSProperties => ({ width: `${width}px` }),
};

function Positioned() {
  const [wide, setWide] = createSignal(false);
  const [trigger, setTrigger] = createSignal<HTMLElement>();
  return (
    <Popover.Root>
      <Popover.Trigger
        ref={setTrigger}
        data-testid="positioned-trigger"
        data-ref-forwarded={trigger() === undefined ? "false" : "true"}
        class={["border border-line rounded-md text-ink px-2.5 py-1.5", wide() ? "bg-selected" : "bg-page"]}
      >
        Open
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner data-testid="positioned-positioner" sideOffset={6} class="z-30" style={styles.width(wide() ? 280 : 200)}>
          <Popover.Popup data-testid="positioned-popup" class="border border-line rounded-lg bg-page text-ink p-3 shadow-float">
            <button
              type="button"
              data-testid="positioned-resize"
              data-wide={wide() ? "true" : "false"}
              class="border border-line rounded-md bg-page text-ink px-2.5 py-1.5"
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
  frame: "bg-page",
  stories: { Dynamic: story({ render: () => <Positioned /> }) },
});
