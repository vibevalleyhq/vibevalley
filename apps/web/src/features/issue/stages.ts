// An issue's stage on its page: talk, work, finish.

import { t } from "@vibevalley/i18n";

import type { IssueStatus } from "@vibevalley/protocol";
/** The three acts of a plot (docs/concepts.md): talk it through, get it worked, finish it. */
export type Stage = "talk" | "work" | "finish";

export const stages: Stage[] = ["talk", "work", "finish"];

export const stageLabel: Record<Stage, string> = {
  talk: t("web.issue.boardLabels.stage.talk"),
  work: t("web.issue.boardLabels.stage.work"),
  finish: t("web.issue.boardLabels.stage.finish"),
};

export function stageOf(s: IssueStatus): Stage {
  if (s === "backlog") return "talk";
  if (s === "todo" || s === "in_progress") return "work";
  return "finish";
}
