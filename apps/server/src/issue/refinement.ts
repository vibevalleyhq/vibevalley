import { Effect, Result, Schema, Semaphore } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, cut } from "@vibevalley/protocol/rules";

import type { Agent } from "#/agent/agent.ts";
import { clip } from "#/base/clip.ts";
import { type ApiError, refused, lookIn, messageOf } from "#/base/errors.ts";
import { lastJsonBlock, misfitField } from "#/base/json.ts";
import { questionsFromText } from "#/base/questions.ts";
import type { Channel } from "#/channel/channel.ts";
import type { Core } from "#/core/core.ts";
import type { WorkplaceRelease } from "#/repo/workplace.ts";
import { chooseAgent } from "#/runtime/presets.ts";
import type { Runtime } from "#/runtime/runtime.ts";
import type { Hired, HireOptions, Session } from "#/session/session.ts";

import { splitBrief } from "./brief.ts";
import type { IssueLifecycle } from "./lifecycle.ts";
import { draftMatch, refinementBrief } from "./prompts.ts";
import { isForOrchestrator } from "./status.ts";

interface RefinementDeps {
  readonly core: Core["Service"];
  readonly store: Agent["Service"];
  readonly runtimes: Runtime["Service"];
  readonly sessions: Session["Service"];
  readonly chat: Channel["Service"];
  readonly get: (ref: string) => Effect.Effect<T.Issue, ApiError>;
  /** The issue while it was never sent. */
  readonly unsent: (id: string) => Effect.Effect<T.Issue, ApiError>;
  readonly hire: (agent: T.Agent, brief: string, repo: string, opt?: HireOptions) => Effect.Effect<Hired, ApiError>;
  readonly lastAssigneeIn: IssueLifecycle["lastAssigneeIn"];
  readonly saveEdit: IssueLifecycle["saveEdit"];
  readonly saveRefinement: IssueLifecycle["saveRefinement"];
}

export function refinement(d: RefinementDeps) {
  const { core, store, runtimes, sessions, chat, get, unsent, hire, lastAssigneeIn, saveEdit, saveRefinement } = d;
  /** One draft starts at a time: two clicks do not send two sessions. */
  const drafting = Semaphore.makeUnsafe(1);

  /** Who drafts: its current assignment. else whoever last worked in its repo, if available. */
  const refiner = Effect.fnUntraced(function* (issue: T.Issue) {
    const candidates = yield* runtimes.candidates;
    let named = "";
    const agent = assignedAgentOf(issue);
    if (agent) {
      if (!store.agent(agent)) return yield* Effect.fail(refused(t("server.issue.profileGone", { id: agent })));
      named = agent;
    } else if (issue.repo) {
      const last = yield* lastAssigneeIn(issue.repo);
      if (last && candidates.some((c) => c.agent.id === last && c.usable)) named = last;
    }
    const chosen = chooseAgent(candidates, draftMatch(issue.title), named, "");
    if (!chosen) return yield* Effect.fail(refused(t("server.issue.refinement.noDrafter"), [lookIn.agent]));
    return chosen;
  });

  const beforeRefinement = Effect.fnUntraced(function* (issue: T.Issue, word: string, agent: string, where: string) {
    let [title, description] = [issue.title, issue.description];
    if (word && issue.questions.length === 0 && !description && issue.criteria.length === 0) [title, description] = splitBrief(word);
    yield* saveEdit(issue.id, {
      title,
      description,
      repo: issue.repo ?? where,
      priority: issue.priority,
      criteria: issue.criteria,
      deliver: issue.deliver,
      agent: assignedAgentOf(issue) ?? agent,
      clearQuestions: Boolean(word && issue.questions.length > 0),
    });
  });

  const refined = (id: string, draftResult: IssueRefinement, questions: readonly T.Question[] | undefined) =>
    saveRefinement(id, draftResult.title, refinementDescription(draftResult), kept(draftResult.criteria), questions);

  const draft = Effect.fn("Issue.refine")(
    function* (id: string, word: string, channel: string) {
      const item = yield* unsent(id);
      if (isForOrchestrator(item, store.isOrchestrator)) return yield* Effect.fail(refused(t("server.issue.refinement.orchestrator")));
      if (item.status !== "backlog") return yield* Effect.fail(refused(t("server.issue.refinement.onlyBacklog")));
      if (item.refining) return yield* Effect.fail(refused(t("server.issue.refinement.drafting", { name: item.refining.name })));
      const chosen = yield* refiner(item);
      const where = item.repo ?? chosen.workdir.trim();
      if (!where) return yield* Effect.fail(refused(t("server.issue.refinement.noRepo")));
      const said = word.trim();
      const brief = refinementBrief(item, said, where);
      yield* beforeRefinement(item, said, chosen.id, where);
      // A draft cut short (a restart) may have left the worktree as its refiner had it: each draft starts from main.
      const kept = yield* sessions.clearWorkplace(item.id, where, item.number);
      if (kept.kept) yield* Effect.logInfo(`vibevalley: issue ${item.id}: before its draft: ${kept.reason}`);
      // Always a worktree, even for a profile that works in the repo folder: the reset after it must not touch the owner's checkout.
      const hired = yield* hire(chosen, brief, where, { worktree: true, channel, issue: id, trigger: { kind: "refine" }, refining: true });
      if (!hired.session) return yield* Effect.fail(refused(hired.refused ?? t("server.issue.sendFailed")));
      return yield* get(id);
    },
    (effect) => drafting.withPermits(1)(effect),
  );

  const handedBack = Effect.fn("Issue.handedBack")(function* (f: { id: string; outcome: string; summary: string; questions?: readonly T.Question[] }) {
    const h = sessions.sessionOf(f.id);
    if (h?.refining !== true || !h.issue) return;
    const id = h.issue;
    const said = sessions.lastTextOf(f.id);
    const thread = yield* chat.threadOfSession(f.id);
    const tell = (text: string) => (thread ? chat.notice(thread, text, "issue_refinement") : core.notice("warn", text));
    if (f.outcome === "completed") {
      const { draft: d, problem } = parseRefinement(said);
      if (!d) yield* tell(t("server.issue.refinement.unread", { name: h.name, problem }));
      else yield* refined(id, d, f.questions && f.questions.length > 0 ? f.questions : questionsFromText(said));
    } else yield* tell(t("server.issue.refinement.unfinished", { name: h.name, summary: f.summary }));
    yield* sessions.dismiss(f.id, "discard");
  });

  const clearRefinement = Effect.fn("Issue.clearRefinement")(function* (issue: T.Issue): Effect.fn.Return<WorkplaceRelease, ApiError> {
    if (issue.refining) yield* sessions.dismiss(issue.refining.session, "discard");
    if (issue.repo) {
      const kept = yield* sessions.clearWorkplace(issue.id, issue.repo, issue.number);
      if (kept.kept) yield* core.notice("warn", t("server.issue.refinement.canceled", { title: cut(issue.title, 40), why: kept.reason }));
      return kept;
    }
    return { kept: false };
  });

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

const Text = Schema.optional(Schema.NullOr(Schema.String));
const Lines = Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)])));

/** A draft as the drafter writes it: a missing or null field is empty, one line may stand for a list. */
const RefinementBlock = Schema.Struct({ title: Text, why: Text, todo: Lines, criteria: Lines, notDoing: Lines, files: Lines });

const textFields = new Set(["title", "why"]);

const linesOf = (v: (typeof RefinementBlock.Type)["todo"]): string[] => (v == null ? [] : typeof v === "string" ? [v] : [...v]);

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
  if (Result.isFailure(read)) return { problem: read.failure };
  const d = read.success;
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
