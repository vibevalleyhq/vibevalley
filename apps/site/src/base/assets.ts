import { byName } from "./files";
import type { StoryArt } from "./story";

const tiles = byName(
  import.meta.glob<string>(
    [
      "@game/site/tiles/{a_bear,a_fox,a_owl,a_rabbit}.webp",
      "@game/site/tiles/{b_bookshop,b_notice_pavilion,b_study_courtyard,b_warehouse,b_waterwheel_mill}.webp",
      "@game/site/tiles/{p_bamboo,p_boat,p_lantern_post,p_willow}.webp",
      "@game/site/tiles/{t_bridge_arch,t_crop_sprout,t_crop_wheat,t_grass,t_paddy_water,t_soil_bed}.webp",
    ],
    { eager: true, query: "?url", import: "default" },
  ),
);

const avatars = byName(
  import.meta.glob<string>("@game/avatars/species-{bear,rabbit,fox,cat,owl,hedgehog,raccoon}.png", {
    eager: true,
    query: "?url",
    import: "default",
  }),
);

const engines = byName(
  import.meta.glob<string>("@game/engines/{opencode,claude,codex,vibevalley,connector-weixin}.png", {
    eager: true,
    query: "?url",
    import: "default",
  }),
);

/** An isometric Papertrails diorama cutout from assets/site/tiles/. */
export function tileArt(name: string): string {
  const url = tiles[`${name}.webp`];
  if (!url) throw new Error(`Missing Papertrails tile: ${name}`);
  return url;
}

/** A Papertrails cardstock portrait from assets/avatars/. */
export function avatarArt(name: string): string {
  const url = avatars[`${name}.png`];
  if (!url) throw new Error(`Missing Papertrails avatar: ${name}`);
  return url;
}

/** A Papertrails engine or connector emblem from assets/engines/. */
export function engineArt(name: string): string {
  const url = engines[`${name}.png`];
  if (!url) throw new Error(`Missing Papertrails engine emblem: ${name}`);
  return url;
}

/** The seven species helpers parading across the farm. */
export const WALKERS = [
  { look: "bear", portrait: avatarArt("species-bear"), figurine: tileArt("a_bear") },
  { look: "rabbit", portrait: avatarArt("species-rabbit"), figurine: tileArt("a_rabbit") },
  { look: "fox", portrait: avatarArt("species-fox"), figurine: tileArt("a_fox") },
  { look: "cat", portrait: avatarArt("species-cat") },
  { look: "owl", portrait: avatarArt("species-owl"), figurine: tileArt("a_owl") },
  { look: "hedgehog", portrait: avatarArt("species-hedgehog") },
  { look: "raccoon", portrait: avatarArt("species-raccoon") },
] as const;

export const RUNTIMES = [
  { name: "OpenCode", logo: engineArt("opencode") },
  { name: "Claude Code", logo: engineArt("claude") },
  { name: "Codex", logo: engineArt("codex") },
] as const;

export function storyArt(): StoryArt {
  return {
    helper: tileArt("a_bear"),
    b_notice_pavilion: tileArt("b_notice_pavilion"),
    b_study_courtyard: tileArt("b_study_courtyard"),
    b_waterwheel_mill: tileArt("b_waterwheel_mill"),
    b_warehouse: tileArt("b_warehouse"),
    b_bookshop: tileArt("b_bookshop"),
    t_bridge_arch: tileArt("t_bridge_arch"),
    p_boat: tileArt("p_boat"),
    t_soil_bed: tileArt("t_soil_bed"),
    t_paddy_water: tileArt("t_paddy_water"),
    t_crop_sprout: tileArt("t_crop_sprout"),
    t_crop_wheat: tileArt("t_crop_wheat"),
    p_bamboo: tileArt("p_bamboo"),
    p_willow: tileArt("p_willow"),
    p_lantern_post: tileArt("p_lantern_post"),
  };
}
