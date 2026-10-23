// The farm's numbers the page counts up (Features.tsx), each from the game's own lists: when one of those changes,
// change it here. Labels are in the dictionaries (features.tally), by key.

export const FACTS = [
  // The machines in use: VibeValley's own, pi, claude, codex (.agents/notes/proposed/feature/2026-10-10-other-runtimes.md).
  { key: 'machines', n: 4, icon: 'machine-tractor' },
  // 7 species × 4 outfits (packages/protocol/src/shapes.ts).
  { key: 'looks', n: 28, icon: 'bear-farmer-side' },
  // Helpers at work at once (maxRunning, packages/protocol/src/shapes.ts).
  { key: 'plots', n: 6, icon: 'plot-wheat' },
  // The achievements in apps/server/src/agent/seeds.json.
  { key: 'achievements', n: 21, icon: 'icon-trophy' },
  // The games on the farm phone (apps/web/src/farm/phone/screens.tsx).
  { key: 'games', n: 5, icon: 'icon-star' },
  // WeChat, Feishu, QQ (packages/protocol/src/shapes.ts, ConnectorIDValues).
  { key: 'connectors', n: 3, icon: 'icon-pigeon' },
] as const

export type FactKey = (typeof FACTS)[number]['key']
