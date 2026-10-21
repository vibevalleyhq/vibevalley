// Writing an issue from a sentence and remembering the last pick: framework-free, for the board and the farm.

import { type Issue, VibeValleyApiError } from "@vibevalley/protocol";
import { api } from "../../data/api";
import { newIssueTitle } from "../../rules/issues";

const pickKey = "vibevalley.board.pick";

/** The helper and project last picked on this machine, for the next quick add. */
export function rememberedPick(): { agent: string; project: string } {
  try {
    const raw = JSON.parse(localStorage.getItem(pickKey) ?? "null") as unknown;
    if (Array.isArray(raw) && raw.length === 2) return { agent: String(raw[0]), project: String(raw[1]) };
  } catch {
    // No storage: nothing remembered.
  }
  return { agent: "", project: "" };
}

export function rememberPick(agent: string, project: string) {
  if (!agent && !project) return;
  try {
    localStorage.setItem(pickKey, JSON.stringify([agent, project]));
  } catch {
    // The issue is saved already; remembering is best-effort.
  }
}

/** The plus: an issue made at once in the backlog. With words, they are its title and its draft starts from them; the
 * issue is made even when the server refuses the draft, and `refused` says why. */
export async function writeIssue(text: string, agent: string, project: string): Promise<{ issue: Issue; refused: string }> {
  const last = rememberedPick();
  const who = agent || last.agent;
  const where = project || last.project;
  const words = text.trim();
  const made = await api.issue.create({ body: { title: words || newIssueTitle, project: where || undefined, assignee: who || undefined } });
  if (!words) return { issue: made, refused: "" };
  try {
    return { issue: await api.issue.draft({ id: made.id, body: { text: words } }), refused: "" };
  } catch (e) {
    if (e instanceof VibeValleyApiError) return { issue: made, refused: e.reason };
    throw e;
  }
}

/** A key for one sent word, so a retry is not said twice. */
export const newSendKey = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
