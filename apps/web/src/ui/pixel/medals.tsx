import type { SpriteAtlas } from "./atlas";

// Where the ribbon frames' empty disc is, as a share of the square.
const disc = { size: 0.44, centerY: 0.409 };

/** `tier` 1 bronze, 2 silver, 3 or more gold; a one-off's medal is gold. The emblem falls back to the wreath. */
export function EarnedMedal(props: { atlas: SpriteAtlas; achievement: string; tier: number; oneOff?: boolean; size?: number }) {
  const size = () => props.size ?? 48;
  const t = () => (props.oneOff === true ? 3 : props.tier);
  const frame = () => props.atlas.get(t() === 1 ? "medal-bronze" : t() === 2 ? "medal-silver" : "medal-gold");
  const emblem = () => props.atlas.first([`emblem-${props.achievement}`, "emblem-wreath"]);
  const e = () => size() * disc.size;
  return (
    <span class="relative inline-block shrink-0" style={{ width: `${size()}px`, height: `${size()}px` }} aria-hidden="true">
      <img src={frame().url} alt="" draggable="false" class="absolute inset-0 size-full object-contain [image-rendering:pixelated]" />
      <img
        src={emblem().url}
        alt=""
        draggable="false"
        class="absolute object-contain [image-rendering:pixelated]"
        style={{ left: `${(size() - e()) / 2}px`, top: `${size() * disc.centerY - e() / 2}px`, width: `${e()}px`, height: `${e()}px` }}
      />
    </span>
  );
}
