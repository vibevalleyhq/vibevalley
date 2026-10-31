// Writing an issue from a sentence: framework-free, for the board and the farm. The last pick is the prefs' (state/prefs.ts).

import { type Issue, VibeValleyApiError } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { api, newSendKey } from "@/infra/api";
import { prefsNow } from "@/state/prefs";

import { newIssueTitle } from "./titles";
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
  const made = await api.issue.create(omitUndefined({ title: words || newIssueTitle, project: where || undefined, assignee: who || undefined, requestKey }));
  if (!words) return { issue: made, refused: "" };
  try {
    return { issue: await api.issue.refine({ id: made.id, text: words }), refused: "" };
  } catch (e) {
    if (e instanceof VibeValleyApiError) return { issue: made, refused: e.reason };
    throw e;
  }
}
