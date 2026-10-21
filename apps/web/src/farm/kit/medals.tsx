import type { SpriteAtlas } from "../world/sprites";

// Where the ribbon frames' empty disc is, as a share of the square.
const disc = { size: 0.44, centerY: 0.409 };

/** `tier` 1 bronze, 2 silver, 3 or more gold; a one-off's medal is gold. The emblem falls back to the wreath. */
export function EarnedMedal({
  atlas,
  achievement,
  tier,
  oneOff = false,
  size = 48,
}: {
  atlas: SpriteAtlas;
  achievement: string;
  tier: number;
  oneOff?: boolean;
  size?: number;
}) {
  const t = oneOff ? 3 : tier;
  const frame = atlas.get(t === 1 ? "medal-bronze" : t === 2 ? "medal-silver" : "medal-gold");
  const emblem = atlas.first([`emblem-${achievement}`, "emblem-wreath"]);
  const e = size * disc.size;
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }} aria-hidden>
      <img src={frame.url} alt="" draggable={false} className="absolute inset-0 size-full object-contain [image-rendering:pixelated]" />
      <img
        src={emblem.url}
        alt=""
        draggable={false}
        className="absolute object-contain [image-rendering:pixelated]"
        style={{ left: (size - e) / 2, top: size * disc.centerY - e / 2, width: e, height: e }}
      />
    </span>
  );
}
