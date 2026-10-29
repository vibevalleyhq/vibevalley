// A run of an issue's in words: what started it and how it went.

import { t } from "@vibevalley/i18n";

import type { Run, RunTrigger } from "@vibevalley/protocol";
function runTriggerText(trigger: RunTrigger) {
  switch (trigger.kind) {
    case "issue":
      return t("web.issue.trigger.issue");
    case "comment":
      return trigger.message ? t("web.issue.trigger.commentNumbered", { id: trigger.message.slice(0, 8) }) : t("web.issue.trigger.comment");
    case "task":
      return t("web.issue.trigger.task");
    case "cron":
      return trigger.missed ? t("web.issue.trigger.missed") : t("web.issue.trigger.cron");
    case "refine":
      return t("web.issue.trigger.refine");
    case "runtime":
      return t("web.issue.trigger.runtime");
  }
}

/** One line for a run: what started it, how it went, how long, what it cost, what it heard while it ran. */
export const runText = (r: Run, now: number, took: (ms: number) => string) =>
  [
    runTriggerText(r.triggeredBy),
    r.outcome ? t(`shared.outcome.${r.outcome}`) : t("web.issue.run.working"),
    took((r.endedAt ?? now) - r.startedAt),
    ...(r.spent?.cny !== undefined ? [`¥${r.spent.cny.toFixed(2)}`] : []),
    ...(r.heard.length ? [t("web.issue.run.heard", { n: r.heard.length })] : []),
  ].join(" · ");
