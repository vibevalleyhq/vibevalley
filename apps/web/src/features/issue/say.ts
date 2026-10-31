// Words for the helper on an issue (an answer, 打回's findings, a word mid-turn): an intent (state/intent.ts) keyed by
// the comment's sendKey, so a retry after a lost reply is said once. The box empties at once and the words show under it
// until a frame at least as new as the reply comes (issue.comment.create answers the seq); a failed one stays there with
// why, to say again with its key or take back into the box.

import type { Applied } from "@vibevalley/protocol";

import { api } from "@/infra/api";
import { bySeq, defineIntent, type Intent } from "@/state/intent";

export interface IssueSaid {
  readonly id: string;
  readonly text: string;
}

export const issueSay = defineIntent<IssueSaid, Applied>({
  send: (s, key) => api.issue.comment.create({ id: s.id, text: s.text, sendKey: key }),
  confirmed: bySeq,
  whileLost: "queue",
  timeoutMs: 20_000,
});

/** Words said on an issue and not yet shown by a frame. */
export interface PendingWords {
  readonly key: string;
  readonly text: string;
  readonly state: "sending" | "failed";
  readonly reason?: string;
}

/** The words said on this issue on their way, oldest first. */
export function pendingWords(says: readonly Intent<IssueSaid, Applied>[], issue: string): PendingWords[] {
  return says
    .filter((s) => s.input.id === issue)
    .map((s) =>
      s.status === "failed"
        ? { key: s.key, text: s.input.text, state: "failed", ...(s.reason === undefined ? {} : { reason: s.reason }) }
        : { key: s.key, text: s.input.text, state: "sending" },
    );
}
