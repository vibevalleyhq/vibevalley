import type { Attachment, ChatMessage, Milestone, Run } from "@vibevalley/protocol";

import { extractInlineAttachmentIds } from "../../../design/Markdown";

export type ActivityItem =
  | {
      readonly kind: "milestone";
      readonly key: string;
      readonly at: number;
      readonly milestone: Milestone;
      /** Matched Run record when `milestone.run` resolves to a known run. */
      readonly run?: Run;
      /** True on the single milestone responsible for rendering expandable per-run steps. */
      readonly attachRunSteps: boolean;
    }
  | {
      readonly kind: "message";
      readonly key: string;
      readonly at: number;
      readonly message: ChatMessage;
    };

interface RankedEntry {
  readonly item: ActivityItem;
  readonly rank: number;
  readonly index: number;
}

/** Filters attachments already rendered inline inside Markdown image syntax. */
export function remainingMessageAttachments(message: { text: string; attachments: readonly Attachment[] }): readonly Attachment[] | undefined {
  if (message.attachments.length === 0) return undefined;
  const inlineIds = extractInlineAttachmentIds(message.text);
  if (inlineIds.size === 0) return message.attachments;
  const rest = message.attachments.filter((file) => !inlineIds.has(file.id));
  return rest.length > 0 ? rest : undefined;
}

function compareKeys(keys: readonly (readonly [number, number])[]): number {
  for (const [a, b] of keys) {
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Merges issue milestones, discussion messages, and run metadata into a single
 * chronological oldest-first activity stream. For each run, expandable per-run
 * steps attach once to its latest milestone (the outcome milestone when finished,
 * or the started milestone while in progress).
 */
export function mergeIssueActivity(milestones: readonly Milestone[], messages: readonly ChatMessage[], runs: readonly Run[] = []): readonly ActivityItem[] {
  const runById = new Map(runs.map((r) => [r.id, r]));

  const sortedMilestones = milestones
    .map((milestone, index) => ({ milestone, index }))
    .toSorted((a, b) =>
      compareKeys([
        [a.milestone.at, b.milestone.at],
        [a.index, b.index],
      ]),
    );

  const lastIndexByRun = new Map<string, number>();
  sortedMilestones.forEach(({ milestone }, idx) => {
    if (milestone.run !== undefined) lastIndexByRun.set(milestone.run, idx);
  });

  const milestoneOcc = new Map<string, number>();
  const ranked: RankedEntry[] = [];

  sortedMilestones.forEach(({ milestone }, idx) => {
    const baseKey = `${milestone.at}:${milestone.kind}:${milestone.run ?? ""}`;
    const occ = milestoneOcc.get(baseKey) ?? 0;
    milestoneOcc.set(baseKey, occ + 1);
    const run = milestone.run !== undefined ? runById.get(milestone.run) : undefined;
    const attachRunSteps = milestone.run !== undefined && lastIndexByRun.get(milestone.run) === idx;
    const item: ActivityItem =
      run !== undefined
        ? {
            kind: "milestone",
            key: `ms:${baseKey}:${occ}`,
            at: milestone.at,
            milestone,
            run,
            attachRunSteps,
          }
        : {
            kind: "milestone",
            key: `ms:${baseKey}:${occ}`,
            at: milestone.at,
            milestone,
            attachRunSteps,
          };
    ranked.push({
      item,
      rank: milestone.kind === "opened" ? 0 : 2,
      index: idx,
    });
  });

  const visibleMessages = messages
    .filter((m) => m.deleted === undefined)
    .map((message, index) => ({ message, index }))
    .toSorted((a, b) =>
      compareKeys([
        [a.message.at, b.message.at],
        [a.message.number, b.message.number],
        [a.index, b.index],
      ]),
    );

  visibleMessages.forEach(({ message }, idx) => {
    ranked.push({
      item: {
        kind: "message",
        key: `msg:${message.id}`,
        at: message.at,
        message,
      },
      rank: 1,
      index: idx,
    });
  });

  return ranked
    .toSorted((a, b) =>
      compareKeys([
        [a.item.at, b.item.at],
        [a.rank, b.rank],
        [a.index, b.index],
      ]),
    )
    .map((entry) => entry.item);
}
