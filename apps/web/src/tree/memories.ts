import { t } from "@vibevalley/i18n";

import type { MemoryItem, MemoryKind, TreeStage } from "./mock";
/** Only the name: the stage itself comes with the data (MemoryTree.stage). */
export const stageName = (stage: TreeStage) => t(`web.tree.stage.${stage}`);

export interface TreeFilter {
  /** "" is every helper, every repo. */
  readonly agent: string;
  readonly repo: string;
}

export const allOf: TreeFilter = { agent: "", repo: "" };

/** A memory for every repo is kept under any repo. */
export function kept(item: MemoryItem, filter: TreeFilter): boolean {
  return (filter.agent === "" || item.agent === filter.agent) && (filter.repo === "" || item.repo === null || item.repo === filter.repo);
}

export function counts(items: readonly MemoryItem[]): Record<MemoryKind | "fading", number> {
  const n = { leaf: 0, fruit: 0, seed: 0, fading: 0 };
  for (const m of items) {
    n[m.kind] += 1;
    if (m.fading) n.fading += 1;
  }
  return n;
}

export function newest(items: readonly MemoryItem[], limit: number): MemoryItem[] {
  return [...items].toSorted((a, b) => b.at - a.at).slice(0, limit);
}

/** After a recall, its item flashes for this long. */
export const flashFor = 10 * 60_000;
