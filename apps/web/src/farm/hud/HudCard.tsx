import type { JSX } from "@solidjs/web";

const styles = {
  height: (height: number): JSX.CSSProperties => ({ height: `${height}px` }),
};

/** A wooden card the height of the HUD's row, an icon and words. */
export function HudCard(props: { height?: number; bright?: boolean; children: JSX.Element }) {
  return (
    <span class="inline-block pr-0.5 pb-0.5">
      <span
        class={[
          "box-border flex items-center gap-1 border-2 border-bark-850 bg-glow-soft px-2 font-pixel text-(length:--text-xs) text-bark-850 shadow-px-shade",
          props.bright === true && "[filter:brightness(110%)]",
        ]}
        style={props.height !== undefined ? styles.height(props.height) : undefined}
      >
        {props.children}
      </span>
    </span>
  );
}
