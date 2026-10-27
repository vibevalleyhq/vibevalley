import type { JSX } from "@solidjs/web";
import { CardColors } from "../../ui/pixel";

/** A wooden card the height of the HUD's row, an icon and words. */
export function HudCard(props: { height?: number; bright?: boolean; children: JSX.Element }) {
  return (
    <span class="inline-block pr-0.5 pb-0.5">
      <span
        class={["box-border flex items-center gap-1 border-2 px-2 font-pixel text-[12px]", { "brightness-110": !!props.bright }]}
        style={{
          height: props.height !== undefined ? `${props.height}px` : undefined,
          background: CardColors.paper,
          "border-color": CardColors.ink,
          color: CardColors.ink,
          "box-shadow": "2px 2px 0 0 #3a2a1899",
        }}
      >
        {props.children}
      </span>
    </span>
  );
}
