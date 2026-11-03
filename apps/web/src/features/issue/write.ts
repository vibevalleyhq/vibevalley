// Writing an issue from a sentence: framework-free, for the board and the farm. The last pick is the prefs' (state/prefs.ts).
// Besides the words that make an issue, an issue delivers and it hears words while they are on their way.

import { type Applied, type AppliedIssue, type Deliverable, type Issue, VibeValleyApiError } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { api, newSendKey } from "@/infra/api";
import { bySeq, defineIntent, type Intent } from "@/state/intent";
import { prefsNow } from "@/state/prefs";

import { newIssueTitle } from "./issue";
/**
 * The request key of the issue a box writes: the same words written again after a failure (a lost reply) are the same
 * issue, made once; other words, or the same once it went through, are another.
 */
export function createWriteKey() {
  let last: { readonly words: string; readonly key: string } | undefined;
  return {
    for: (words: string) => {
      if (last?.words !== words) last = { words, key: newSendKey() };
      return last.key;
    },
    used: () => void (last = undefined),
  };
}

/** The plus: an issue made at once in the backlog. With words, they are its title and its draft starts from them; the
 * issue is made even when the server refuses the draft, and `refused` says why. */
export async function writeIssue(text: string, agent: string, project: string, requestKey: string): Promise<{ issue: Issue; refused: string }> {
  const last = prefsNow();
  const who = agent || (last.pick === "auto" ? "" : last.pick);
  const where = project || last.project;
  const words = text.trim();
  const made = await api.issue.create(omitUndefined({ title: words || newIssueTitle, project: where || undefined, agent: who || undefined, requestKey }));
  if (!words) return { issue: made, refused: "" };
  try {
    return { issue: await api.issue.refine({ id: made.id, text: words }), refused: "" };
  } catch (e) {
    if (e instanceof VibeValleyApiError) return { issue: made, refused: e.reason };
    throw e;
  }
}

// What an issue delivers, picked by the owner on its page: an intent (state/intent.ts) on issue.update, settled by the
// frame whose seq is the reply's. Until then the pick shows the owner's choice, not the frame's old one; a refused pick
// shows the frame's again, marked failed.

export interface DeliverPick {
  readonly id: string;
  readonly deliver: Deliverable;
}

export const issueDeliver = defineIntent<DeliverPick, AppliedIssue>({
  // A set: sent twice, it is set once, so it needs no request key.
  send: (p) => api.issue.update({ id: p.id, deliver: p.deliver }),
  confirmed: bySeq,
  whileLost: "queue",
  timeoutMs: 20_000,
});

/** The deliverable the pick shows, and whether the owner's choice is on its way or was refused. */
export function shownDeliver(
  id: string,
  frame: Deliverable,
  picks: readonly Intent<DeliverPick, AppliedIssue>[],
): { readonly value: Deliverable; readonly state?: "pending" | "failed" } {
  const p = picks.findLast((x) => x.input.id === id);
  if (!p) return { value: frame };
  return p.status === "failed" ? { value: frame, state: "failed" } : { value: p.input.deliver, state: "pending" };
}

// Words for the helper on an issue (an answer, 打回's findings, a word mid-turn): an intent (state/intent.ts) keyed by
// the comment's sendKey, so a retry after a lost reply is said once. The box empties at once and the words show under it
// until a frame at least as new as the reply comes (issue.comment.create answers the seq); a failed one stays there with
// why, to say again with its key or take back into the box.

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
