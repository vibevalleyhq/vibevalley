/** What a dot says (docs/style/design.md, 状态色): well or done (leaf), waiting or thinking (wheat), failed (berry),
 * information (water), nobody at work (idle), quiet (faint, muted). */
export type DotTone = "leaf" | "wheat" | "berry" | "water" | "idle" | "faint" | "muted";

const dotColor: Record<DotTone, string> = {
  leaf: "bg-leaf",
  wheat: "bg-wheat",
  berry: "bg-berry",
  water: "bg-water",
  idle: "bg-idle",
  faint: "bg-faint",
  muted: "bg-muted",
};

/** A round status dot. ring: drawn on a face or a picture, it is ringed in the page colour to stand off it. */
export function Dot(props: { tone: DotTone; size?: number; ring?: boolean; class?: string }) {
  return (
    <span
      class={["inline-block shrink-0 rounded-full", dotColor[props.tone], { "ring-2 ring-page": props.ring !== false }, props.class]}
      style={{ width: `${props.size ?? 9}px`, height: `${props.size ?? 9}px` }}
      aria-hidden="true"
    />
  );
}
