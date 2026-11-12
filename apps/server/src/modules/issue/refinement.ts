import { z } from "zod";

import { Semaphore } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, cut } from "@vibevalley/protocol/rules";

import { clip } from "#/base/clip.ts";
import { BizCode, lookIn, messageOf, refuseIn } from "#/base/errors.ts";
import { lastJsonBlock, misfitField } from "#/base/json.ts";
import { questionsFromText } from "#/base/questions.ts";
import type { Core } from "#/core/core.ts";
import type { Logger } from "#/infra/log.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { WorkplaceRelease } from "#/modules/repo/workplace.ts";
import { chooseAgent } from "#/modules/runtime/presets.ts";
import type { Runtime } from "#/modules/runtime/runtime.ts";
import { type Hired, type HireOptions, HireRefused, type Session } from "#/modules/session/session.ts";

import { splitBrief } from "./brief.ts";
import type { IssueLifecycle } from "./lifecycle.ts";
import { draftMatch, refinementBrief } from "./prompts.ts";
import { assignedOnDuty } from "./status.ts";

const refused = refuseIn(BizCode.IssueRefused);

interface RefinementDeps {
  readonly core: Core;
  readonly log: Logger;
  readonly store: Agent;
  readonly runtimes: Runtime;
  readonly sessions: Session;
  readonly chat: Channel;
  readonly get: (ref: string) => Promise<T.Issue>;
  /** The issue while it was never sent. */
  readonly unsent: (id: string) => Promise<T.Issue>;
  /** Throws HireRefused. */
  readonly hire: (agent: T.Agent, brief: string, repo: string, opt?: HireOptions) => Promise<Hired>;
  readonly lastAssigneeIn: IssueLifecycle["lastAssigneeIn"];
  readonly saveEdit: IssueLifecycle["saveEdit"];
  readonly saveRefinement: IssueLifecycle["saveRefinement"];
}

export function refinement(d: RefinementDeps) {
  const { core, log, store, runtimes, sessions, chat, get, unsent, hire, lastAssigneeIn, saveEdit, saveRefinement } = d;
  /** One draft starts at a time: two clicks do not send two sessions. */
  const drafting = new Semaphore(1);

  const refiner = async (issue: T.Issue) => {
    const candidates = await runtimes.candidates();
    let named = "";
    const agent = assignedAgentOf(issue);
    if (agent) {
      if (!store.agent(agent)) throw refused(t("server.issue.profileGone", { id: agent }));
      named = agent;
    } else if (issue.repo) {
      const last = await lastAssigneeIn(issue.repo);
      if (last && candidates.some((c) => c.agent.id === last && c.usable)) named = last;
    }
    const chosen = chooseAgent(candidates, draftMatch(issue.title), named, "");
    if (!chosen) throw refused(t("server.issue.refinement.noDrafter"), [lookIn.agent]);
    return chosen;
  };

  const beforeRefinement = async (issue: T.Issue, word: string, agent: string, where: string) => {
    let [title, description] = [issue.title, issue.description];
    if (word && issue.questions.length === 0 && !description && issue.criteria.length === 0) [title, description] = splitBrief(word);
    await saveEdit(issue.id, {
      title,
      description,
      repo: issue.repo ?? (where || undefined),
      priority: issue.priority,
      criteria: issue.criteria,
      deliver: issue.deliver,
      agent: assignedAgentOf(issue) ?? agent,
      clearQuestions: Boolean(word && issue.questions.length > 0),
    });
  };

  const refined = (id: string, draftResult: IssueRefinement, questions: readonly T.Question[] | undefined) =>
    saveRefinement(id, draftResult.title, refinementDescription(draftResult), kept(draftResult.criteria), questions);

  const draft = (id: string, word: string, channel: string): Promise<T.Issue> =>
    drafting.with(async () => {
      const item = await unsent(id);
      if (assignedOnDuty(item, store.isOrchestrator)) throw refused(t("server.issue.refinement.orchestrator"));
      if (item.status !== "backlog") throw refused(t("server.issue.refinement.onlyBacklog"));
      if (item.refining) throw refused(t("server.issue.refinement.drafting", { name: item.refining.name }));
      const chosen = await refiner(item);
      const where = item.repo ?? chosen.workdir.trim();
      const said = word.trim();
      const thread = await chat.issueThread(item.id, item.title, channel || undefined);
      const history = await chat.history(thread, undefined, 40);
      const brief = refinementBrief(item, said, where, history.map((message) => message.text).join("\n\n"));
      if (said) await chat.post({ _tag: "User", text: said, channel: thread, sendKey: "" });
      await beforeRefinement(item, said, chosen.id, where);
      // A draft cut short (a restart) may have left the worktree as its refiner had it: each draft starts from main.
      const kept = where ? await sessions.clearWorkplace(item.id, where, item.number) : { kept: false };
      if (kept.kept) log.info(`vibevalley: issue ${item.id}: retained draft workplace`);
      // Always a worktree, even for a profile that works in the repo folder: the reset after it must not touch the user's checkout.
      try {
        await hire(chosen, brief, where, { worktree: true, channel, issue: id, trigger: { kind: "refine" }, refining: true });
      } catch (e) {
        if (e instanceof HireRefused) throw refused(e.reason);
        throw e;
      }
      return get(id);
    });

  const handedBack = async (f: { id: string; outcome: string; summary: string; questions?: readonly T.Question[] }) => {
    const h = sessions.sessionOf(f.id);
    if (h?.refining !== true || !h.issue) return;
    const id = h.issue;
    const said = sessions.lastTextOf(f.id);
    const thread = await chat.threadOfSession(f.id);
    const tell = async (text: string) => {
      if (thread) await chat.post({ _tag: "Notice", channel: thread, text: text, code: "issue_refinement" });
      else core.notice("warn", text);
    };
    if (f.outcome === "completed") {
      const { draft: d, problem } = parseRefinement(said);
      if (!d) await tell(t("server.issue.refinement.unread", { name: h.name, problem }));
      else {
        const questions = f.questions && f.questions.length > 0 ? f.questions : questionsFromText(said);
        await refined(id, d, questions);
        await tell(
          [d.title, refinementDescription(d), ...d.criteria, ...questions.map((question) => [question.question, ...question.options].join("\n"))].join("\n\n"),
        );
      }
    } else await tell(t("server.issue.refinement.unfinished", { name: h.name, summary: f.summary }));
    await sessions.dismiss(f.id, "discard");
  };

  const clearRefinement = async (issue: T.Issue): Promise<WorkplaceRelease> => {
    if (issue.refining) await sessions.dismiss(issue.refining.session, "discard");
    if (issue.repo) {
      const kept = await sessions.clearWorkplace(issue.id, issue.repo, issue.number);
      if (kept.kept) core.notice("warn", t("server.issue.refinement.canceled", { title: cut(issue.title, 40), why: kept.reason }));
      return kept;
    }
    return { kept: false };
  };

  return { draft, handedBack, clearRefinement };
}

/** A list may come as one string. */
interface IssueRefinement {
  readonly title: string;
  readonly why: string;
  readonly todo: string[];
  readonly criteria: string[];
  readonly notDoing: string[];
  readonly files: string[];
}

export const kept = (lines: readonly string[] | undefined) => (lines ?? []).map((l) => l.trim()).filter((l) => l !== "");

export const openQuestions = (questions: readonly T.Question[] | undefined): T.Question[] => (questions ?? []).filter((a) => a.question.trim() !== "");

const Text = z.string().nullable().optional();
const Lines = z
  .union([z.string(), z.array(z.string())])
  .nullable()
  .optional();

/** A draft as the drafter writes it: a missing or null field is empty, one line may stand for a list. */
const RefinementBlock = z.object({ title: Text, why: Text, todo: Lines, criteria: Lines, notDoing: Lines, files: Lines });

const textFields = new Set(["title", "why"]);

const linesOf = (v: z.infer<typeof RefinementBlock>["todo"]): string[] => (v == null ? [] : typeof v === "string" ? [v] : [...v]);

/** The last block that reads as a draft with a title; problem says why none did. */
export function parseRefinement(text: string): { draft?: IssueRefinement; problem: string } {
  const read = lastJsonBlock(text, RefinementBlock, {
    none: t("server.issue.refinement.noBlock"),
    unparsed: (e) => t("server.issue.refinement.unreadable", { why: messageOf(e) }),
    misfit: (issue) => {
      const field = misfitField(issue);
      const why =
        field === undefined
          ? t("server.issue.refinement.notObject")
          : textFields.has(field)
            ? t("server.issue.refinement.text", { field })
            : t("server.issue.refinement.lines", { field });
      return t("server.issue.refinement.unreadable", { why });
    },
    refuse: (d) => (clip(d.title ?? "", 80) ? undefined : t("server.issue.refinement.noTitle")),
  });
  if (!read.ok) return { problem: read.problem };
  const d = read.value;
  return {
    draft: {
      title: clip(d.title ?? "", 80),
      why: d.why ?? "",
      todo: linesOf(d.todo),
      criteria: linesOf(d.criteria),
      notDoing: linesOf(d.notDoing),
      files: linesOf(d.files),
    },
    problem: "",
  };
}

export function refinementDescription(d: IssueRefinement): string {
  const parts: string[] = [];
  const why = d.why.trim();
  if (why) parts.push(t("server.issue.refinement.why") + "\n" + why);
  for (const [head, lines] of [
    [t("server.issue.refinement.todo"), kept(d.todo)],
    [t("server.issue.refinement.notDoing"), kept(d.notDoing)],
    [t("server.issue.refinement.files"), kept(d.files)],
  ] as const)
    if (lines.length > 0) parts.push(head + "\n- " + lines.join("\n- "));
  return parts.join("\n\n");
}
