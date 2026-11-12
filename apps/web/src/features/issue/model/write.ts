import { type Applied, type AppliedIssue, type Issue, type IssueUpdate, VibeValleyApiError } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { api, newSendKey } from "#/infra/api.ts";
import { bySeq, defineIntent, type Intent, type Intents, sendReplacing } from "#/state/intent.ts";
import { prefsNow } from "#/state/prefs.ts";

import { newIssueTitle } from "./issue";
/** The request key of the issue a box writes: the same words written again after a failure (a lost reply) are the same issue, made once. */
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

/** The plus: an issue made at once in the backlog. With words, they are its title and its draft starts from them. */
export async function writeIssue(text: string, agent: string, repo: string, requestKey: string): Promise<{ issue: Issue; refused: string }> {
  const last = prefsNow();
  const who = agent || (last.pick === "auto" ? "" : last.pick);
  const where = repo || last.repo;
  const words = text.trim();
  const made = await api.issue.create(omitUndefined({ title: words || newIssueTitle, repo: where || undefined, agent: who || undefined, requestKey }));
  if (!words) return { issue: made, refused: "" };
  try {
    return { issue: await api.issue.refine({ id: made.id, text: words }), refused: "" };
  } catch (e) {
    if (e instanceof VibeValleyApiError) return { issue: made, refused: e.reason };
    throw e;
  }
}

// An issue's labels set by the user on its page (title, priority, what it delivers): an intent (state/intent.ts) on issue.update,
// settled by the frame whose seq is the reply's. The server takes them while the issue is open, sent or not.

export type IssueLabels = Pick<IssueUpdate, "title" | "priority" | "deliver">;
export type IssueLabel = keyof IssueLabels;

export type IssueSet = { readonly id: string } & IssueLabels;

export const issueSet = defineIntent<IssueSet, AppliedIssue>({
  // A set: sent twice, it is set once, so it needs no request key.
  send: (p) => api.issue.update(p),
  confirmed: bySeq,
  whileLost: "queue",
  timeoutMs: 20_000,
});

type LabelSets = readonly Intent<IssueSet, AppliedIssue>[];

const labelsOf = (p: IssueSet) => (["title", "priority", "deliver"] as const).filter((k) => p[k] !== undefined);
const newestSet = (sets: LabelSets, id: string, label: IssueLabel) => sets.findLast((p) => p.input.id === id && p.input[label] !== undefined);

/** A newer set of the same label of the same issue replaces the one still on its way. */
export const sendLabel = (sets: Intents<IssueSet, AppliedIssue>, set: IssueSet) =>
  sendReplacing(sets, set, (a, b) => a.id === b.id && labelsOf(a).every((k) => labelsOf(set).includes(k)));

const labeled = (issue: Issue, sets: LabelSets) => {
  const kept = (label: IssueLabel) => {
    const p = newestSet(sets, issue.id, label);
    return p?.phase === "failed" ? undefined : p?.input;
  };
  const state = (label: IssueLabel) => {
    const p = newestSet(sets, issue.id, label);
    return p === undefined ? undefined : p.phase === "failed" ? ("failed" as const) : ("pending" as const);
  };
  const labels = omitUndefined({ title: kept("title")?.title, priority: kept("priority")?.priority, deliver: kept("deliver")?.deliver });
  return { issue: { ...issue, ...labels }, state };
};

/**
 * The issue as its page shows it, with the labels the user set and the frame has not caught up with yet,
 * and whether each label's newest choice is on its way or was refused (the value shown is then the frame's again).
 */
export function labeledIssue(sets: LabelSets): (issue: Issue) => ReturnType<typeof labeled>;
export function labeledIssue(issue: Issue, sets: LabelSets): ReturnType<typeof labeled>;
export function labeledIssue(...args: [LabelSets] | [Issue, LabelSets]) {
  if (args.length === 1) {
    const [sets] = args;
    return (issue: Issue) => labeled(issue, sets);
  }
  return labeled(...args);
}

// Words for the helper on an issue (an answer, reject's findings, a word mid-turn).

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
      s.phase === "failed" ? { key: s.key, text: s.input.text, state: "failed", reason: s.fault.reason } : { key: s.key, text: s.input.text, state: "sending" },
    );
}
