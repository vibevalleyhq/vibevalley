export const FACTS = [
  { key: "views", n: 2, art: { kind: "tile", name: "b_study_courtyard" } },
  // 7 species × 4 outfits (SpeciesValues, OutfitValues in packages/protocol/src/agent/shapes.ts).
  { key: "looks", n: 28, art: { kind: "avatar", name: "species-bear" } },
  // Helpers at work at once (maxRunning, packages/protocol/src/common/shapes.ts).
  { key: "plots", n: 6, art: { kind: "tile", name: "t_crop_wheat" } },
  { key: "achievements", n: 21, art: { kind: "tile", name: "b_notice_pavilion" } },
  // GameId in apps/mac/ui/farm/PhoneGames.tsx.
  { key: "games", n: 5, art: { kind: "tile", name: "p_boat" } },
  // WeChat, Feishu, QQ (packages/protocol/src/connector/shapes.gen.ts, ConnectorIDValues).
  { key: "connectors", n: 3, art: { kind: "engine", name: "connector-weixin" } },
] as const;
