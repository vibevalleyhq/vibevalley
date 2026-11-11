import { Formatter } from "effect";

import { maybe, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { executionsOf } from "@vibevalley/protocol/rules";

import type { WrittenKind, WrittenTemplate } from "#/modules/agent/seed.ts";
import type { AddIssueParams } from "#db/issue.sql.ts";

import { assignedOnDuty } from "./status.ts";

export const maxChildren = 12;

export const issueRow = (id: string, req: T.IssueRequest, mandate: T.IssueMandate, at: number, cron?: string): AddIssueParams => ({
  id,
  title: req.title,
  description: req.description ?? "",
  origin_trigger_id: mandate.originTriggerId ?? null,
  mandate_strength: mandate.strength,
  max_bot_review_rounds: mandate.maxBotReviewRounds,
  auto_submit_pr: mandate.autoSubmitPr,
  repo: req.repo?.trim() || null,
  parent: req.parent ?? null,
  blocked_by: (req.blockedBy?.length ?? 0) > 0 ? Formatter.formatJson(req.blockedBy) : null,
  constraints: req.constraints ? Formatter.formatJson(req.constraints) : null,
  criteria: (req.criteria?.length ?? 0) > 0 ? Formatter.formatJson(req.criteria) : null,
  priority: req.priority ?? "medium",
  created_at: at,
  cron: cron ?? null,
  deliver: req.deliver ?? "change",
});

const defaultBotReviewRounds = 3;
export const mandateNoteWordLimit = 30;
const words = new Intl.Segmenter("und", { granularity: "word" });

export function mandateNoteFits(text: string): boolean {
  let count = 0;
  for (const word of words.segment(text)) if (word.isWordLike === true && ++count > mandateNoteWordLimit) return false;
  return true;
}

const mandate = (strength: T.IssueMandate["strength"], originTriggerId: string, autoSubmitPr: boolean): T.IssueMandate => ({
  ...(originTriggerId === "" ? {} : { originTriggerId }),
  strength,
  maxBotReviewRounds: defaultBotReviewRounds,
  autoSubmitPr,
});

export const explicitMandate = (originTriggerId = "", autoSubmitPr = false): T.IssueMandate => mandate("explicit", originTriggerId, autoSubmitPr);
export const inferredMandate = (originTriggerId = ""): T.IssueMandate => mandate("inferred", originTriggerId, false);

const recentTitles = 5;

/** A title longer than this is a long instruction, not one to send again. */
const recentTitleLength = 60;

export function sentTitles(all: readonly T.Issue[], repo: string, orchestrator: (id: string) => boolean): string[] {
  const mine = all
    .filter((i) => i.repo === repo && executionsOf(i).length > 0 && i.parent === undefined && i.cron === undefined && !assignedOnDuty(i, orchestrator))
    .toSorted((a, b) => b.createdAt - a.createdAt);
  const out: string[] = [];
  for (const i of mine) {
    const title = i.title.split(/\s+/u).filter(Boolean).join(" ");
    if (!title || [...title].length > recentTitleLength || out.includes(title)) continue;
    out.push(title);
    if (out.length === recentTitles) break;
  }
  return out;
}

const commandHoles = /\s?\{(test|lint|build)\}\s?/gu;

/** A known command goes in as code, spaced from the words around it; an unknown one is a plain word, unspaced as Chinese is. */
export function filledTemplate(s: WrittenTemplate, stack: Partial<T.RepoStack>): T.RepoTemplates["kinds"][number]["templates"][number] {
  const commands: Record<string, string | undefined> = { test: stack.test, lint: stack.lint, build: stack.build };
  const done = s.done.replace(commandHoles, (hole, name: string) =>
    commands[name] ? hole.replace(`{${name}}`, "`" + commands[name] + "`") : (maybe(`server.issue.template.commands.${name}`) ?? hole),
  );
  const text = t("server.issue.template.done", { title: s.title, done });
  const blank = firstBlank(text);
  return { id: s.id, title: s.title, done, text, ...(blank ? { blank } : {}) };
}

export const filledKinds = (kinds: readonly WrittenKind[], stack: Partial<T.RepoStack>): T.RepoTemplates["kinds"] =>
  kinds.map((k) => ({ ...k, templates: k.templates.map((template) => filledTemplate(template, stack)) }));

function firstBlank(text: string): NonNullable<T.RepoTemplates["kinds"][number]["templates"][number]["blank"]> | undefined {
  const m = /〔[^〕]*〕/u.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : undefined;
}
