import { t } from "@vibevalley/i18n";
import type { IssueRetroReport, RetroBreakdownBucket, RetroWindow } from "@vibevalley/protocol";

import { spanText, tookText } from "../../infra/base/format";

const DAY_MS = 86_400_000;

export function retroWindowLabel(window: RetroWindow): string {
  switch (window) {
    case "7d":
      return t("web.base.dashboard.retro.window.7d");
    case "14d":
      return t("web.base.dashboard.retro.window.14d");
    case "30d":
      return t("web.base.dashboard.retro.window.30d");
    case "all":
      return t("web.base.dashboard.retro.window.all");
  }
}

export function retroDurationText(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return ms >= DAY_MS ? spanText(ms) : tookText(ms);
}

export function retroRateText(pct: number | undefined): string {
  return pct === undefined ? "—" : `${pct}%`;
}

function bucketLabel(kind: "repo" | "tag" | "agent", key: string, agentName: (id: string) => string): string {
  if (key !== "") return kind === "agent" ? agentName(key) : key;
  switch (kind) {
    case "repo":
      return t("web.base.dashboard.retro.breakdown.noRepo");
    case "tag":
      return t("web.base.dashboard.retro.breakdown.untagged");
    case "agent":
      return t("web.base.dashboard.retro.breakdown.unassigned");
  }
}

function appendBreakdown(
  lines: string[],
  title: string,
  kind: "repo" | "tag" | "agent",
  buckets: readonly RetroBreakdownBucket[],
  agentName: (id: string) => string,
) {
  if (buckets.length === 0) return;
  lines.push("", `## ${title}`);
  for (const bucket of buckets) {
    const label = bucketLabel(kind, bucket.key, agentName);
    const meta = t("web.base.dashboard.retro.breakdown.bucketMeta", {
      done: bucket.completedCount,
      rework: bucket.reworkCount,
      overdue: bucket.overdueCount,
    });
    const median =
      bucket.medianCycleMs !== undefined
        ? ` · ${t("web.base.dashboard.retro.breakdown.medianShort", { median: retroDurationText(bucket.medianCycleMs) })}`
        : "";
    lines.push(`- **${label}**: ${bucket.totalCount} (${meta}${median})`);
  }
}

/** Formats a server-computed `IssueRetroReport` as a standup/weekly-retro Markdown summary. */
export function formatRetroMarkdown(report: IssueRetroReport, agentName: (id: string) => string): string {
  const lines: string[] = [
    `# ${t("web.base.dashboard.retro.markdown.heading", { window: retroWindowLabel(report.window) })}`,
    "",
    `## ${t("web.base.dashboard.retro.markdown.summary")}`,
    `- ${t("web.base.dashboard.retro.markdown.throughputLine", {
      done: report.completedCount,
      canceled: report.canceledCount,
      open: report.openCount,
      total: report.totalIssues,
    })}`,
    `- ${t("web.base.dashboard.retro.markdown.cycleLine", {
      median: retroDurationText(report.cycleTime.medianMs),
      p90: retroDurationText(report.cycleTime.p90Ms),
      n: report.cycleTime.sampleCount,
    })}`,
    `- ${t("web.base.dashboard.retro.markdown.reviewLine", {
      median: retroDurationText(report.reviewWait.medianMs),
      p90: retroDurationText(report.reviewWait.p90Ms),
      n: report.reviewWait.sampleCount,
    })}`,
    `- ${t("web.base.dashboard.retro.markdown.dueLine", {
      onTimeRate: retroRateText(report.onTimeRatePct),
      onTime: report.onTimeCount,
      overdue: report.overdueCount,
      noDue: report.withoutDueCount,
    })}`,
    `- ${t("web.base.dashboard.retro.markdown.reworkLine", {
      reworkRate: retroRateText(report.reworkRatePct),
      issues: report.reworkIssueCount,
      findings: report.totalFindingsCount,
      unresolved: report.unresolvedFindingsCount,
    })}`,
  ];

  if (report.overdueItems.length > 0) {
    lines.push("", `## ${t("web.base.dashboard.retro.overdue.title")}`);
    for (const item of report.overdueItems) {
      const owner = [item.repo, item.agent ? agentName(item.agent) : undefined].filter(Boolean).join(" / ");
      lines.push(`- #${item.number} ${item.title}${owner ? ` (${owner})` : ""} — +${retroDurationText(item.overdueMs)}`);
    }
  }

  if (report.reworkItems.length > 0) {
    lines.push("", `## ${t("web.base.dashboard.retro.rework.title")}`);
    for (const item of report.reworkItems) {
      const owner = [item.repo, item.agent ? agentName(item.agent) : undefined].filter(Boolean).join(" / ");
      const openText =
        item.unresolvedCount > 0
          ? t("web.base.dashboard.retro.rework.unresolved", { n: item.unresolvedCount })
          : t("web.base.dashboard.retro.rework.allResolved");
      lines.push(`- #${item.number} ${item.title}${owner ? ` (${owner})` : ""} — ${item.findingsCount} (${openText})`);
    }
  }

  appendBreakdown(lines, t("web.base.dashboard.retro.breakdown.byRepo"), "repo", report.byRepo, agentName);
  appendBreakdown(lines, t("web.base.dashboard.retro.breakdown.byTag"), "tag", report.byTag, agentName);
  appendBreakdown(lines, t("web.base.dashboard.retro.breakdown.byAgent"), "agent", report.byAgent, agentName);

  return lines.join("\n");
}
