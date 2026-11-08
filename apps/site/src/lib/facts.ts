export const FACTS = [
  // VibeValley's own, pi, Claude Code, and Codex.
  { key: "machines", n: 4, icon: "machine-tractor" },
  // 7 species × 4 outfits (packages/protocol/src/shapes.ts).
  { key: "looks", n: 28, icon: "bear-farmer-side" },
  // Helpers at work at once (maxRunning, packages/protocol/src/shapes.ts).
  { key: "plots", n: 6, icon: "plot-wheat" },
  // The achievements in apps/server/src/agent/seeds.json.
  { key: "achievements", n: 21, icon: "icon-trophy" },
  // The games on the farm phone (apps/web/src/farm/phone/screens.tsx).
  { key: "games", n: 5, icon: "icon-star" },
  // WeChat, Feishu, QQ (packages/protocol/src/shapes.ts, ConnectorIDValues).
  { key: "connectors", n: 3, icon: "icon-pigeon" },
] as const;
