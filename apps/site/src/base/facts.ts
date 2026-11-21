export const FACTS = [
  { key: "views", n: 2, icon: "machine-tractor" },
  // 7 species × 4 outfits (SpeciesValues, OutfitValues in packages/protocol/src/agent/shapes.ts).
  { key: "looks", n: 28, icon: "bear-farmer-side" },
  // Helpers at work at once (maxRunning, packages/protocol/src/common/shapes.ts).
  { key: "plots", n: 6, icon: "plot-wheat" },
  { key: "achievements", n: 21, icon: "icon-trophy" },
  // GameId in apps/mac/ui/farm/PhoneGames.tsx.
  { key: "games", n: 5, icon: "icon-star" },
  // WeChat, Feishu, QQ (packages/protocol/src/connector/shapes.gen.ts, ConnectorIDValues).
  { key: "connectors", n: 3, icon: "icon-pigeon" },
] as const;
