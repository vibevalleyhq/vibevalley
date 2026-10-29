// What the memory tree page shows of the memories (for now mock.ts's): what a filter keeps, the counts, the newest and
// the last recalled. Presentation only; the stage's number comes with the data (MemoryTree.stage).

import { t } from "@vibevalley/i18n";
import type { MemoryItem, MemoryKind, TreeStage } from "./mock";
/** What each stage is called; the stage itself is the server's (MemoryTree.stage). */
export const stageName = (stage: TreeStage) => t(`web.tree.stage.${stage}`);

export interface TreeFilter {
  /** "" is every helper, every project. */
  readonly agent: string;
  readonly project: string;
}

export const allOf: TreeFilter = { agent: "", project: "" };

/** Whether a memory is kept by the filter; a memory for every project is kept under any project. */
export function kept(item: MemoryItem, filter: TreeFilter): boolean {
  return (filter.agent === "" || item.agent === filter.agent) && (filter.project === "" || item.project === null || item.project === filter.project);
}

export function counts(items: readonly MemoryItem[]): Record<MemoryKind | "fading", number> {
  const n = { leaf: 0, fruit: 0, seed: 0, fading: 0 };
  for (const m of items) {
    n[m.kind] += 1;
    if (m.fading) n.fading += 1;
  }
  return n;
}

/** The newest first. */
export function newest(items: readonly MemoryItem[], limit: number): MemoryItem[] {
  return [...items].sort((a, b) => b.at - a.at).slice(0, limit);
}

export function lastRecalled(items: readonly MemoryItem[]): MemoryItem | undefined {
  let best: MemoryItem | undefined;
  for (const m of items) if (m.recalledAt !== undefined && (best?.recalledAt === undefined || m.recalledAt > best.recalledAt)) best = m;
  return best;
}

/** Recalled this recently: it flashes on the tree and in the sky. */
export const flashFor = 10 * 60_000;
