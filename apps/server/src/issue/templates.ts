// The sowing form's offers: the templates filled for a project's stack, and the titles lately sent there.

import { maybe, t } from "@vibevalley/i18n";
import type { WrittenKind, WrittenTemplate } from "@/agent/seed.ts";
import type { Issue, IssueTemplate, ProjectStack, TemplateBlank, TemplateKind } from "@vibevalley/protocol";
import { isForOrchestrator } from "./status.ts";
const recentTitles = 5;

/** A title longer than this is a long instruction, not one to send again. */
const recentTitleLength = 60;

/** orchestrator: whether a profile id is an orchestrator's. */
export function sentTitles(all: readonly Issue[], project: string, orchestrator: (id: string) => boolean): string[] {
  const mine = all
    .filter(
      (i) =>
        i.project === project &&
        i.sessions.length > 0 &&
        !i.graph &&
        !i.task &&
        i.parent === undefined &&
        i.cron === undefined &&
        !isForOrchestrator(i, orchestrator),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const out: string[] = [];
  for (const i of mine) {
    const title = i.title.split(/\s+/).filter(Boolean).join(" ");
    if (!title || [...title].length > recentTitleLength || out.includes(title)) continue;
    out.push(title);
    if (out.length === recentTitles) break;
  }
  return out;
}

const commandHoles = /\s?\{(test|lint|build)\}\s?/g;

/** A known command goes in as code, spaced from the words around it; an unknown one is a plain word, unspaced as Chinese is. */
export function filledTemplate(s: WrittenTemplate, stack: Partial<ProjectStack>): IssueTemplate {
  const commands: Record<string, string | undefined> = { test: stack.test, lint: stack.lint, build: stack.build };
  const done = s.done.replace(commandHoles, (hole, name: string) =>
    commands[name] ? hole.replace(`{${name}}`, "`" + commands[name] + "`") : (maybe(`server.issue.template.commands.${name}`) ?? hole),
  );
  const text = t("server.issue.template.done", { title: s.title, done });
  const blank = firstBlank(text);
  return { id: s.id, title: s.title, done, text, ...(blank ? { blank } : {}) };
}

export const filledKinds = (kinds: readonly WrittenKind[], stack: Partial<ProjectStack>): TemplateKind[] =>
  kinds.map((k) => ({ ...k, templates: k.templates.map((template) => filledTemplate(template, stack)) }));

function firstBlank(text: string): TemplateBlank | undefined {
  const m = /〔[^〕]*〕/.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : undefined;
}
