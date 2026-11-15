import { merge, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator } from "@vibevalley/protocol";
import { assignedAgentOf, issueScopeOf, latestSessionIdOf, sessionIdsOf, shortTitle } from "@vibevalley/protocol/rules";
import { sessionId } from "@vibevalley/protocol/schema";

import { actsForUser, type Actor, user as userActor } from "#/base/actor.ts";
import { ApiError, BizCode, lookIn, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Repo } from "#/modules/repo/repo.ts";
import type { Hired, SessionNews, Session } from "#/modules/session/session.ts";
import type { Trigger } from "#/modules/session/shapes.ts";

import { findingsOf, milestonesOf } from "./brief.ts";
import { templateCatalog } from "./catalog.ts";
import { explicitMandate, filledKinds, inferredMandate, mandateNoteFits, sentTitles } from "./creation.ts";
import { type Dispatched, issueDispatch, type IssueHireOptions } from "./dispatch.ts";
import { makeGitHubPoller } from "./github.ts";
import { readyInputs } from "./inputs.ts";
import { type Intake, issueIntake } from "./intake.ts";
import { issueLanding } from "./landing.ts";
import { issueLifecycle } from "./lifecycle.ts";
import { nextSteps } from "./moves.ts";
import { needsUser } from "./prompts.ts";
import { kept, refinement } from "./refinement.ts";
import { issueSettling, type StatusOptions } from "./settle.ts";
import { issueSplitting } from "./split.ts";
import { assignedOnDuty, conflictOf, type Finding, isClosed, type IssueChildDraft, type IssueConstraints, type IssueMandate, pickIssues } from "./status.ts";
import type { Due } from "./when.ts";

export type { IssueChildDraft, IssueConstraints, IssueMandate };

const refused = refuseIn(BizCode.IssueRefused);

export class AgentChoiceRefused extends Error {
  override readonly name = "AgentChoiceRefused";
  readonly kind: "noneAvailable" | "notFound";
  readonly key: string;
  constructor(kind: "noneAvailable" | "notFound", key: string) {
    super(`${kind}: ${key}`);
    this.kind = kind;
    this.key = key;
  }
}

export type IssueCreateRefusal = "draftWithStart" | "noteTooLong" | "noChannel" | "noDefaultRepo" | "agentChoice" | "notRecorded";

export class IssueCreateRefused extends Error {
  override readonly name = "IssueCreateRefused";
  readonly channel?: string;
  readonly choice?: AgentChoiceRefused;
  readonly error?: ApiError;
  readonly reason: IssueCreateRefusal;
  constructor(reason: IssueCreateRefusal, more: { readonly channel?: string; readonly choice?: AgentChoiceRefused; readonly error?: ApiError } = {}) {
    super(reason);
    this.reason = reason;
    if (more.channel !== undefined) this.channel = more.channel;
    if (more.choice !== undefined) this.choice = more.choice;
    if (more.error !== undefined) this.error = more.error;
  }
}

export interface IssueCreateInput {
  readonly title: string;
  readonly parent?: string;
  readonly blockedBy?: readonly string[];
  readonly constraints?: IssueConstraints;
  readonly description?: string;
  readonly repo?: string;
  readonly agent?: string;
  readonly priority?: T.Priority;
  readonly deliver?: T.Deliverable;
  readonly criteria?: readonly string[];
  readonly autoSubmitPr?: boolean;
  readonly by: Actor;
  readonly envelope?: string;
  /** Channel name when `channelByName` is true; otherwise channel or thread id (defaults to farm default channel). */
  readonly channel?: string;
  readonly channelByName?: boolean;
  readonly pickedAgent?: string;
  readonly chooseAgent?: boolean;
  readonly enforceNoteLimit?: boolean;
  readonly start?: boolean;
  readonly draft?: boolean;
}

export type IssueCreateStep =
  | { readonly _tag: "Backlog" }
  | {
      readonly _tag: "Dispatched";
      readonly channelName: string;
      readonly repo: string;
      readonly queued?: string;
      readonly session?: T.Session;
    }
  | { readonly _tag: "StartFailed"; readonly error: ApiError }
  | { readonly _tag: "Drafting" }
  | { readonly _tag: "DraftFailed"; readonly error: ApiError };

export interface IssueCreated {
  readonly issue: T.Issue;
  readonly step: IssueCreateStep;
}

export interface CommentReceipt {
  readonly thread?: string;
  readonly worker?: T.Session;
}

export interface Issue {
  readonly list: () => Promise<T.Issue[]>;
  readonly query: (f: T.IssueFilter) => Promise<T.Issue[]>;
  readonly onBoard: () => readonly T.Issue[];
  readonly get: (id: string) => Promise<T.Issue>;
  readonly add: (req: T.IssueRequest, mandate: IssueMandate) => Promise<T.Issue>;
  /** Throws ApiError or IssueCreateRefused. */
  readonly create: (input: IssueCreateInput) => Promise<IssueCreated>;
  /** Throws AgentChoiceRefused. */
  readonly chooseAgent: (brief: string, name: string, picked: string) => Promise<T.Agent>;
  readonly edit: (id: string, upd: T.IssueUpdate, by: Actor) => Promise<T.Issue>;
  readonly remove: (id: string) => Promise<void>;
  readonly start: (id: string, channel: string) => Promise<Dispatched>;
  readonly split: (id: string, title: string, drafts: readonly IssueChildDraft[], by: Actor) => Promise<string>;
  readonly setStatus: (id: string, to: T.IssueStatus, text: string, channel: string, by: Actor, opt?: StatusOptions) => Promise<T.Issue>;
  readonly stop: (id: string) => Promise<void>;
  readonly previewStatus: (id: string, to: T.IssueStatus, text: string, opt?: StatusOptions, edit?: T.IssueUpdate) => Promise<T.Preview>;
  readonly previewRemove: (id: string) => Promise<T.Preview>;
  /** Resolves `#41`, `41`, an issue id, or the name or id of a helper or session that worked it. */
  readonly idOf: (ref: string) => Promise<T.IssueId>;
  readonly comment: (id: string, text: string, sendKey?: string, by?: Actor) => Promise<CommentReceipt>;
  readonly changes: (id: string, by: Actor) => Promise<T.Changes>;
  readonly review: (id: string, req: IssueReviewRequest) => Promise<T.Issue>;
  readonly refine: (id: string, word: string, channel: string) => Promise<T.Issue>;
  readonly history: () => Promise<T.IssueHistory[]>;
  readonly timeline: (id: string) => Promise<T.IssueTimeline>;
  readonly templates: (repo: string) => Promise<T.RepoTemplates>;
  /** The runs that took the issue's inputs. */
  readonly runs: (id: string) => Promise<T.Run[]>;
  /** If the trigger is in an issue's threads (or already held in its pool), pool it into that issue and flush when
   * runnable; returns whether an issue took it (intake.ts). */
  readonly pool: (trigger: Trigger) => Promise<boolean>;
  /** A recorded non-watch trigger routed: into the pool of the issue whose threads it is in, else to the orchestrator it
   * names or the one of its place (intake.ts). */
  readonly route: (trigger: Trigger) => Promise<void>;
  /** The issue a trigger is an input of. */
  readonly ownerOf: (trigger: string) => Promise<T.IssueId | undefined>;
  /** A helper says an input is not its to take; the orchestrator is told why. */
  readonly decline: (session: string, envelope: string, reason: string) => Promise<void>;
  /** Throws HireRefused. */
  readonly hire: (agent: T.Agent, brief: string, repo: string, opt?: IssueHireOptions) => Promise<Hired>;
  /** Creates or reopens the issue a due cron occurrence routes to, and subscribes its cron thread. */
  readonly scheduled: (due: Due, input: Trigger) => Promise<T.Issue>;
  readonly refreshPullRequests: () => Promise<void>;
  readonly refreshQueue: () => Promise<void>;
  readonly submitPullRequest: (session: string, summary?: string) => Promise<string>;
  /** At startup, after the modules below it started: a first round of the queue, then the queue and the pull requests
   * on their timers. (start is taken: it starts an issue.) */
  readonly boot: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface IssueDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly core: Core;
  readonly agent: Agent;
  readonly repo: Repo;
  readonly session: Session;
  readonly channel: Channel;
}

export interface IssueReviewRequest {
  readonly pass: boolean;
  readonly findings?: readonly string[];
  readonly text?: string;
}

function failedText(findings: readonly Finding[], text: string): string {
  let out = t("server.issue.brief.failedHead");
  let n = 0;
  for (const f of findings) if (!f.resolved) out += `\n${++n}. ${f.text}`;
  if (text) out += "\n\n" + text;
  return out + t("server.issue.brief.failedEnd");
}

/** What of the issues' still points at a channel (the queued issues answering there), so deleting it is refused. */
const channelUses =
  (deps: { readonly queued: () => Promise<readonly { readonly issue: string; readonly trigger: { readonly replyChannel?: string } }[]> }) =>
  async (id: string): Promise<readonly string[]> => {
    const queued = new Set((await deps.queued()).filter((q) => q.trigger.replyChannel === id).map((q) => q.issue)).size;
    return queued !== 0 ? [t("server.channel.queuedThere", { n: queued })] : [];
  };

export type IssueIntake = Intake & { readonly pollGitHub: () => Promise<void> };

const intakes = new WeakMap<Issue, IssueIntake>();

/** An issues module's intake (its pools, subscriptions and routing), for tests only (modules.test.ts keeps it so). */
export function intakeOf(issue: Issue): IssueIntake {
  const intake = intakes.get(issue);
  if (intake === undefined) throw new Error("not an issues module makeIssue made");
  return intake;
}

export async function makeIssue(deps: IssueDeps): Promise<Issue> {
  const { config, clock, core, agent: store, repo: repos, session: sessions, channel: chat, db } = deps;
  const log = deps.log.child("issue");
  const tasks = new TaskGroup({ name: "issue", onError: (task, e) => log.error(`${task} failed:`, e) });
  const intake = issueIntake({ config, clock, log, db, core, agent: store, session: sessions, channel: chat });
  const r = await issueLifecycle({ core, agent: store, session: sessions, intake, db, clock, log });
  const {
    issueOfSession,
    loadKept,
    everyIssue,
    idOf,
    get,
    unsent,
    liveSession,
    issueWords,
    add,
    remove,
    saveEdit,
    complete,
    cancelAs,
    closeIfOpen,
    endRun,
    setConflict,
    revive,
    unqueue,
    recordReport,
    judged,
    userSaid,
    setQueued,
    drop,
  } = r;
  /** Words for a session: said in its home, or in its issue's thread when it has none (the watch routes them). */
  const sayTo = async (from: string, session: string, text: string, sendKey = "") => {
    const live = sessions.live(session);
    let where = await chat.homeOf(session);
    const liveIssue = live.reachable && live.session ? issueScopeOf(live.session) : undefined;
    if (!where && liveIssue && live.session) {
      const issue = await get(liveIssue);
      where = await chat.openThreadAbout("issue", issue.id, issue.title, live.session.channel);
    }
    if (!where) throw missing(t("server.channel.noHelper", { id: session }), [lookIn.session]);
    const run = sessions.live(from).run;
    await chat.post({ from, channel: where, text, sendKey, ...(run ? { run } : {}) });
  };

  const landing = issueLanding(r, { core, log, repo: repos, session: sessions, channel: chat, tell: sayTo });
  const { changesOf, merge: mergeIssue, refreshPullRequests, submit } = landing;
  const { split, joinChildren } = issueSplitting(r, { agent: store, session: sessions, channel: chat, landing });
  const d = issueDispatch(r, joinChildren, { core, agent: store, repo: repos, session: sessions, intake, channel: chat, log });
  const { hire, start, refreshQueue, reopen, scheduled } = d;
  chat.guardRemoval(channelUses({ queued: () => intake.queued() }));
  sessions.useReadiness((inputs) => readyInputs(inputs, (id) => core.state().issues.find((issue) => issue.id === id)));
  const { withEdit, settledMove, stuckWords, movesWords } = issueSettling(r, d, {
    agent: store,
    repo: repos,
    session: sessions,
    clock,
    landing,
  });

  const gitHub = makeGitHubPoller({ db, repo: repos, clock, log, receive: intake.receive });
  const pollGitHub = () => gitHub.pollOpen(core.state().issues);

  const chooseAgent = async (brief: string, name: string, picked: string): Promise<T.Agent> => {
    const key = name.trim();
    const chosen = await store.choose(brief, key, picked);
    if (!chosen) throw new AgentChoiceRefused("noneAvailable", key);
    if (key && chosen.id !== key && chosen.name !== key && chosen.runtime !== key) throw new AgentChoiceRefused("notFound", key);
    return chosen;
  };

  const resolveAssignee = (key: string): string => {
    const k = key.trim();
    if (k === "" || k === defaultOrchestrator) return k;
    const found = store.named(k);
    if (!found) throw refused(t("server.issue.noProfileNamed", { key }), [lookIn.agent]);
    return found.id;
  };

  const submitPullRequest = async (rawSession: string, summary?: string) => {
    const session = sessionId(rawSession);
    const issue = issueOfSession(session);
    if (!issue) throw refused(t("server.issue.prSubmitNotCurrent"));
    const item = await get(issue);
    if (latestSessionIdOf(item) !== session) throw refused(t("server.issue.prSubmitNotCurrent"));
    if (item.mandate.strength !== "explicit" || !item.mandate.autoSubmitPr) throw refused(t("server.issue.prSubmitNotAllowed"));
    if (!item.repo || !repos.usesPullRequests(item.repo)) throw refused(t("server.issue.prSubmitUnavailable"));
    return submit(item.id, session, summary);
  };

  const comment = async (id: string, text: string, sendKey: string = "", by: Actor = userActor): Promise<CommentReceipt> => {
    const issue = await get(id);
    const latest = latestSessionIdOf(issue);
    const session = latest === undefined ? undefined : sessions.live(latest).session;
    if (by.kind === "agent") {
      if (!session) return {};
      await sayTo(by.id, session.id, text, sendKey);
      return { worker: session };
    }
    if (isClosed(issue.status)) throw refused(t("server.issue.closedReopen"));
    const thread = await chat.openThreadAbout("issue", issue.id, issue.title, session?.channel);
    await chat.say({ text: text, channel: thread, sendKey: sendKey });
    return { thread, ...(session ? { worker: session } : {}) };
  };

  const cancel = async (id: string): Promise<void> => {
    const item = await get(id);
    for (const child of (await everyIssue()).filter((child) => child.parent === item.id && !isClosed(child.status))) {
      await cancel(child.id);
      await cancelAs(child.id, "dismissed");
    }
    const last = latestSessionIdOf(item);
    if (last === undefined || !sessions.live(last).reachable) return;
    if (!(await sessions.dismiss(last))) throw missing(t("server.issue.helperRef", { id: last }), [lookIn.session]);
  };

  const { draft, handedBack, clearRefinement } = refinement({
    core,
    log,
    store,
    sessions,
    chat,
    get,
    unsent,
    hire,
    lastAssigneeIn: r.lastAssigneeIn,
    saveEdit,
    saveRefinement: r.saveRefinement,
  });

  const create = async (input: IssueCreateInput): Promise<IssueCreated> => {
    if (input.draft === true && input.start === true) throw new IssueCreateRefused("draftWithStart");
    if (input.enforceNoteLimit === true && !mandateNoteFits(input.description ?? "")) throw new IssueCreateRefused("noteTooLong");
    let channel;
    if (input.channelByName === true && input.channel) {
      const byName = await chat.channelByName(input.channel);
      if (!byName) throw new IssueCreateRefused("noChannel", { channel: input.channel });
      channel = byName;
    } else {
      channel = await chat.topOf(input.channel || chat.defaultChannel());
    }
    let parent: T.Issue | undefined;
    if (input.parent) {
      const parentId = await idOf(input.parent);
      parent = await get(parentId);
    }
    const blockedBy: T.IssueId[] = [];
    for (const ref of input.blockedBy ?? []) blockedBy.push(await idOf(ref));
    const repo = (input.repo ?? parent?.repo ?? "").trim() || channel.repo;
    if (input.start === true && !repo) throw new IssueCreateRefused("noDefaultRepo", { channel: channel.name });
    let agent: string | undefined = parent ? assignedAgentOf(parent) : undefined;
    if (input.chooseAgent === true) {
      let chosen: T.Agent;
      try {
        chosen = await chooseAgent(
          input.title + "\n" + (input.description ?? ""),
          input.agent ?? agent ?? "",
          input.start === true ? (input.pickedAgent ?? "") : "",
        );
      } catch (choice) {
        if (choice instanceof AgentChoiceRefused) throw new IssueCreateRefused("agentChoice", { choice });
        throw choice;
      }
      agent = chosen.id;
    } else if (input.agent !== undefined) {
      try {
        agent = resolveAssignee(input.agent);
      } catch (error) {
        if (error instanceof ApiError) throw new IssueCreateRefused("notRecorded", { error });
        throw error;
      }
    }
    const mandate = actsForUser(input.by) ? explicitMandate(input.envelope ?? "", input.autoSubmitPr ?? false) : inferredMandate(input.envelope ?? "");
    let item: T.Issue;
    try {
      item = await add(
        {
          title: input.title,
          ...(parent ? { parent: parent.id } : {}),
          ...(blockedBy.length > 0 ? { blockedBy } : {}),
          ...(input.constraints ? { constraints: input.constraints } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(repo ? { repo } : {}),
          ...(agent !== undefined ? { agent } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          ...(input.deliver ? { deliver: input.deliver } : {}),
          ...(input.criteria ? { criteria: [...input.criteria] } : {}),
        },
        mandate,
      );
    } catch (error) {
      if (error instanceof ApiError) throw new IssueCreateRefused("notRecorded", { error });
      throw error;
    }
    if (input.start === true) {
      let sent: Dispatched;
      try {
        sent = await start(item.id, channel.id);
      } catch (error) {
        if (error instanceof ApiError) return { issue: item, step: { _tag: "StartFailed", error } };
        throw error;
      }
      const h = sent.session ? sessions.live(sent.session).session : undefined;
      return {
        issue: item,
        step: {
          _tag: "Dispatched",
          channelName: channel.name,
          repo: h?.repo ?? repo,
          ...(sent.queued ? { queued: sent.queued } : {}),
          ...(h ? { session: h } : {}),
        },
      };
    }
    if (input.draft === true) {
      try {
        const updated = await draft(item.id, [input.title, input.description ?? ""].join("\n").trim(), channel.id);
        return { issue: updated, step: { _tag: "Drafting" } };
      } catch (error) {
        if (error instanceof ApiError) return { issue: item, step: { _tag: "DraftFailed", error } };
        throw error;
      }
    }
    return { issue: item, step: { _tag: "Backlog" } };
  };

  const onSessionNews = async (n: SessionNews) => {
    switch (n._tag) {
      case "Left":
        await closeIfOpen(n.left.id, n.left.closed);
        return;
      case "Reported": {
        const e = n.report;
        const issue = await recordReport(e.id, e.outcome, e.questions, e.checks, e.answer);
        await handedBack(e);
        if (issue) {
          const conflict = (await get(issue)).conflict;
          if (conflict) {
            const rechecked = await landing.conflictOf(e.id, conflict.base);
            await setConflict(issue, rechecked);
          }
        }
        await joinChildren();
        return;
      }
      case "IssueStarted":
        await bestEffort(log, `vibevalley: run ${n.run} on issue ${n.issue}`, () => intake.ranOn(n.run, n.issue));
        await unqueue(n.issue);
        return;
      case "RunFinished": {
        const ownIssue = n.session ? issueOfSession(n.session) : undefined;
        // In-process orchestrator runs emit no `Reported`; move their issues to await user review when the turn ends.
        for (const id of await intake.issuesOfRun(n.id, ownIssue)) await bestEffort(log, `vibevalley: run ${n.id} finished on issue ${id}`, () => endRun(id));
        return;
      }
      default:
        return;
    }
  };

  const onUserInThread = async (thread: string) => {
    let item: T.Issue;
    try {
      item = await get(thread);
    } catch (e) {
      if (e instanceof ApiError) return;
      throw e;
    }
    if (isClosed(item.status)) return;
    await userSaid(item.id);
  };

  await loadKept();
  const news = sessions.news();
  const userFacts = core.subscribe();
  // Session reports and user thread replies are handled one at a time, in one loop, so they cannot race.
  tasks.run("issue: session news and the user's words", async (signal) => {
    const unsubscribe = () => {
      news.close();
      userFacts.close();
    };
    signal.addEventListener("abort", unsubscribe, { once: true });
    try {
      const words = (async function* () {
        for await (const e of userFacts) {
          if (e.type === "messageChanged" && e.thread && e.message.actor.kind === "user" && e.message.kind === "chat") {
            yield { _tag: "UserSaid" as const, thread: e.thread };
          }
        }
      })();
      for await (const n of merge<SessionNews | { readonly _tag: "UserSaid"; readonly thread: string }>(news, words)) {
        if (n._tag === "UserSaid") await bestEffort(log, `vibevalley: issues after the user's words in ${n.thread}`, () => onUserInThread(n.thread));
        else await bestEffort(log, `vibevalley: issues after ${n._tag}`, () => onSessionNews(n));
      }
    } finally {
      unsubscribe();
    }
  });

  const timeline = async (id: string) => {
    const issue = await get(id);
    const runs = await intake.runsOf(issue.id);
    const names = new Map<string, string>();
    for (const s of new Set(runs.map((r) => r.session))) {
      const found = await sessions.get(s);
      if (found) names.set(s, found.name);
    }
    return milestonesOf(issue, runs, names);
  };

  const facts = core.subscribe();
  tasks.run("issue: advance queued work", async (signal) => {
    signal.addEventListener("abort", () => facts.close(), { once: true });
    try {
      for await (const fact of facts) {
        if (
          fact.type === "issueChanged"
            ? fact.issue.status === "backlog"
            : fact.type !== "sessionLeft" && !(fact.type === "sessionChanged" && issueScopeOf(fact.session) !== undefined)
        )
          continue;
        await bestEffort(log, "issue: advance queued work", () => refreshQueue());
      }
    } finally {
      facts.close();
    }
  });

  /**
   * The title, the priority and `deliver` may change while the issue is open; they are labels, not the work.
   * The rest is what the helper was asked, so it requires `unsent`: changing it after dispatch is a word to the helper.
   */
  const edit = async (id: string, upd: T.IssueUpdate, by: Actor) => {
    if (!actsForUser(by)) throw refused(needsUser);
    const whileOpen =
      upd.description === undefined && upd.repo === undefined && upd.agent === undefined && upd.criteria === undefined && upd.before === undefined;
    let was: T.Issue;
    if (whileOpen) {
      was = await get(id);
      if (isClosed(was.status)) throw refused(t("server.issue.closed"));
    } else was = await unsent(id);
    const [title, description] = issueWords({ title: upd.title ?? was.title, description: upd.description ?? was.description });
    if (upd.repo !== undefined && upd.repo !== was.repo && was.repo) {
      const released = await sessions.clearWorkplace(was.id, was.repo, was.number, "preserve");
      if (released.kept) throw refused(t("server.issue.cannotMoveRepo", { n: was.number, why: released.reason }));
    }
    const criteria = upd.criteria !== undefined ? kept(upd.criteria) : was.criteria;
    let agent = assignedAgentOf(was);
    if (upd.agent !== undefined) agent = resolveAssignee(upd.agent);
    await saveEdit(was.id, {
      title,
      description,
      repo: upd.repo ?? was.repo,
      priority: upd.priority ?? was.priority,
      criteria,
      deliver: upd.deliver ?? was.deliver,
      agent,
      ...(upd.before !== undefined ? { before: upd.before } : {}),
    });
    return get(was.id);
  };

  const review = async (id: string, req: IssueReviewRequest) => {
    const item = await get(id);
    const why = assignedOnDuty(item, store.isOrchestrator)
      ? t("server.issue.orchestratorAnswers")
      : item.status !== "in_review"
        ? t("server.issue.nothingToAccept")
        : "";
    if (why) throw refused(why, nextSteps(item));
    if (req.pass) {
      await judged(
        item.id,
        clock.now(),
        item.findings.map((f) => ({ ...f, resolved: true })),
      );
      return get(item.id);
    }
    const fresh = kept(req.findings);
    const text = (req.text ?? "").trim();
    if (fresh.length === 0 && !text) throw refused(t("server.issue.failNeedsFindings"));
    const at = clock.now();
    const findings = [...item.findings, ...fresh.map((text) => ({ id: newId(), text, at, resolved: false }))];
    await judged(item.id, 0, findings);
    await comment(item.id, failedText(findings, text));
    return get(item.id);
  };

  const setStatus = async (ref: string, to: T.IssueStatus, text: string, channel: string, by: Actor, opt: StatusOptions = {}) => {
    if (!actsForUser(by)) throw refused(needsUser);
    const item = await get(ref);
    const id = item.id;
    const { move, said, taker, delivery } = await settledMove(item, to, text, opt);
    switch (move) {
      case "start": {
        if (taker) await edit(id, { agent: taker.id }, by);
        await start(id, channel);
        const issueThread2 = await chat.openThreadAbout("issue", id, item.title, channel || undefined);
        await chat.notice({
          channel: issueThread2,
          text: t("server.issue.confirmedRequirements", { title: item.title, description: item.description, criteria: item.criteria.join("\n") }),
          code: "issue_confirmed",
        });
        break;
      }
      case "unqueue":
        await setQueued(id, false, chat.defaultChannel());
        break;
      case "round":
        if (taker) {
          // Dismiss the current helper first so at most one session owns the issue's branch.
          await cancel(id);
          await cancelAs(id, "dismissed");
          await reopen(id, said, channel, { kind: "comment" }, taker);
          break;
        }
        if (sessionIdsOf(item).length === 0) await d.start(id, channel, { kind: "comment" }, said);
        else if (said && item.stage.state === "reviewing") await review(id, { pass: false, findings: findingsOf(said) });
        else await comment(id, said || (await stuckWords(item)));
        break;
      case "reopen":
        await reopen(id, said, channel, { kind: "comment" }, taker);
        break;
      case "revive":
        await revive(id);
        break;
      case "complete": {
        const unresolved = item.findings.some((f) => !f.resolved);
        const settleFindings = () =>
          judged(
            id,
            item.reviewedAt ?? 0,
            item.findings.map((f) => ({ ...f, resolved: true })),
          );
        if (delivery === "submit") await mergeIssue(id, true);
        const acceptedDelivery = delivery === "submit" ? "submitted" : delivery;
        if (acceptedDelivery === "kept" || acceptedDelivery === "none" || acceptedDelivery === "submitted") {
          if (unresolved) await settleFindings();
          // Record completion before dismissing the helper so `Left` does not mark the issue canceled.
          await complete(id, acceptedDelivery);
          const last = latestSessionIdOf(item);
          if (last !== undefined && sessions.live(last).reachable) await sessions.dismiss(last, "keep", "completed");
          break;
        }
        await mergeIssue(id, true);
        const updated = await get(id);
        if (updated.pullRequest?.state !== "open") {
          await complete(id, updated.pullRequest ? "pull_request" : "merged");
        }
        if (unresolved) await settleFindings();
        break;
      }
      case "cancel":
        await cancel(id);
        await cancelAs(id, "dismissed");
        break;
      case "drop":
        await cancel(id);
        await clearRefinement(item);
        await drop(id);
        break;
    }
    return get(id);
  };

  /** Startup's timers run here: the queue's wake-up and the pull requests' poll. */
  const startup = async () => {
    await intake.boot();
    await refreshQueue();
    tasks.run("issue: queue wake-up", async (signal) => {
      for (;;) {
        await clock.sleep(config.chat.retryWakeMs, signal);
        await refreshQueue();
      }
    });
    const pollEvery = config.github.prPollSeconds > 0 ? config.github.prPollSeconds * 1000 : 180_000;
    tasks.run("issue: pull requests", async (signal) => {
      for (;;) {
        await clock.sleep(pollEvery, signal);
        await bestEffort(log, "vibevalley: refresh pull requests", () => refreshPullRequests());
        await pollGitHub();
      }
    });
  };

  const issue: Issue = {
    submitPullRequest,
    split,
    onBoard: () => core.state().issues,
    list: () => everyIssue(),
    query: async (f) => pickIssues(await everyIssue(), f, clock.now()),
    get,
    timeline,
    add: (req, mandate) => add(req, mandate),
    create,
    chooseAgent,
    edit,
    remove: async (id) => {
      const item = await unsent(id);
      const cleared = await clearRefinement(item);
      if (cleared.kept) throw refused(t("server.issue.cannotDelete", { n: item.number, why: cleared.reason }));
      await remove(item.id);
    },
    start: (id, channel) => start(id, channel),
    idOf,
    stop: async (id) => {
      await sessions.stop(await liveSession(id));
    },
    setStatus,
    previewStatus: async (id, to, text, opt = {}, edit) => {
      const found = await get(id);
      const item = await withEdit(found, edit);
      const move = await settledMove(item, to, text, opt);
      return { does: await movesWords(move) };
    },
    previewRemove: async (id) => {
      const item = await unsent(id);
      return {
        does: [
          t("server.issue.does.deleteIssue", { n: item.number, title: shortTitle(item.title) }),
          ...(item.refining ? [t("server.issue.does.drafterLeaves", { name: item.refining.name })] : []),
          ...(item.repo ? [t("server.issue.does.cleanWorktree")] : []),
        ],
      };
    },
    comment,
    changes: async (id, by) => {
      const item = await get(id);
      const changes = await changesOf(item);
      if (!changes) throw refused(t("server.issue.notStarted"));
      await setConflict(item.id, conflictOf(changes));
      const session = latestSessionIdOf(item);
      if (by.kind === "user" && session && sessions.live(session).reachable) core.did({ kind: "reviewed", session });
      return changes;
    },
    review,
    refine: draft,
    history: async () => {
      const all = await everyIssue();
      const byId = new Map((await sessions.list()).map((s) => [s.id, s]));
      return all.map((issue) => ({
        issue,
        sessions: sessionIdsOf(issue).flatMap((id) => {
          const s = byId.get(id);
          return s ? [s] : [];
        }),
        missingSessions: sessionIdsOf(issue).filter((id) => !byId.has(id)),
      }));
    },
    templates: async (name) => {
      const stack = await repos.stack(name);
      if (!stack) throw missing(t("server.issue.repoRef", { name }), [lookIn.repo]);
      const all = await everyIssue();
      return { repo: name, stack, recent: sentTitles(all, name, store.isOrchestrator), kinds: filledKinds(templateCatalog(), stack) };
    },
    runs: async (id) => intake.runsOf((await get(id)).id),
    pool: intake.pool,
    route: intake.route,
    ownerOf: intake.ownerOf,
    decline: intake.decline,
    hire,
    scheduled,
    refreshPullRequests,
    refreshQueue,
    boot: startup,
    close: async () => {
      await tasks.close();
      await intake.close();
    },
  };
  intakes.set(issue, { ...intake, pollGitHub });
  return issue;
}
