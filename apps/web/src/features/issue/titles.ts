import { t } from "@vibevalley/i18n";
import type { Issue, TaskGraph } from "@vibevalley/protocol";
export function issueTitle(issue: Issue, graphs: TaskGraph[] = []) {
  const job = issue.title.trim();
  if (!job) return issue.id;
  const graph = issue.parent ? graphs.find((g) => g.id === issue.parent) : undefined;
  if (graph) return `${graph.title} · ${job}`;
  return job.split("\n")[0]!.trim();
}

export function taskLine(g: TaskGraph) {
  switch (g.state) {
    case "splitting":
      return t("web.issue.graph.splitting");
    case "draft":
      return t("web.issue.graph.draft");
    case "running":
      return t("web.issue.graph.running", { done: Math.round(g.settled ?? 0), total: g.tasks.length });
    case "paused":
      return t("web.issue.graph.paused");
    case "ready":
      return t("web.issue.graph.ready");
    case "done":
      return t("web.issue.graph.done");
    case "abandoned":
      return t("web.issue.graph.abandoned");
  }
}

export const newIssueTitle = t("web.issue.boardLabels.newIssue");
