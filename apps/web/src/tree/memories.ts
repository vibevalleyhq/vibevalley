import { t } from "@vibevalley/i18n";
import type { MemoryItem, MemoryKind, TreeStage } from "./mock";
/** Only the name: the stage itself comes with the data (MemoryTree.stage). */
export const stageName = (stage: TreeStage) => t(`web.tree.stage.${stage}`);

export interface TreeFilter {
  /** "" is every helper, every project. */
  readonly agent: string;
  readonly project: string;
}

export const allOf: TreeFilter = { agent: "", project: "" };

/** A memory for every project is kept under any project. */
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

export function newest(items: readonly MemoryItem[], limit: number): MemoryItem[] {
  return [...items].sort((a, b) => b.at - a.at).slice(0, limit);
}

export function lastRecalled(items: readonly MemoryItem[]): MemoryItem | undefined {
  let best: MemoryItem | undefined;
  for (const m of items) if (m.recalledAt !== undefined && (best?.recalledAt === undefined || m.recalledAt > best.recalledAt)) best = m;
  return best;
}

/** After a recall, its item flashes for this long. */
export const flashFor = 10 * 60_000;
