// The tools agents call, defined once: the orchestrator gets them in process, a session over /mcp. A
// tool's rule lives in the service that owns it; a tool reads its arguments, says who is calling, and words the answer.
// Every tool answers in a sentence, a refusal included: the model acts on it.

import {
  type Agent,
  type BlockAttrs,
  DeliverableValues,
  type Issue,
  IssueStatusValues,
  orchestratorAgent,
  type RecurrenceWhen,
  type TaskEdit,
} from "@vibevalley/protocol";
import { closedText, phaseText, shortTitle, attentionWantsOwner } from "@vibevalley/protocol/rules";
import { openFindings } from "../issue/state.ts";
import { isOpen, maxTasks } from "../task/graph.ts";
import { head } from "../base/text.ts";
import { graphText } from "../task/prompts.ts";
import { inboxLines } from "../channel/prompts.ts";
import { Clock, Context, Data, Effect, Layer, Schema } from "effect";
import { Agents } from "../agent/agent.ts";
import type { Actor } from "../base/actor.ts";
import { effectTool } from "../agent/brain/tool.ts";
import type { Tool } from "../agent/loop/agent.ts";
import type { JsonSchema } from "../ai/tools.ts";
import { Channels, type Info, type Spoken } from "../channel/chat.ts";
import { Docs } from "../doc/doc.ts";
import { type ApiError, reasonOf } from "../errors.ts";
import { Issues } from "../issue/issue.ts";
import { foundText, Memories, type SearchQuery } from "../memory/memory.ts";
import { Projects } from "../project/project.ts";
import { Recurrences } from "../recurrence/recurrence.ts";
import type { ToolStart } from "../session/facts.ts";
import { Runtimes } from "../runtime/runtime.ts";
import { type Roster, Sessions } from "../session/session.ts";
import { Tasks } from "../task/task.ts";
import {
  answers,
  blockLine,
  changesText,
  channelLine,
  descriptions,
  issueDetail,
  issueLine,
  memoryWhere,
  noSuchPriority,
  noSuchStatus,
  ownerAgentWord,
  parseTime,
  priorityOf,
  recurrenceLine,
  sessionLine,
  statusOf,
} from "./prompts.ts";
import { parameters, schemas, sessionParameters, sessionSchemas } from "./schemas.ts";
import { toolWording } from "./words.ts";

/** A tool's arguments as its Schema reads them. */
type Orchestrator<K extends keyof typeof parameters> = (typeof parameters)[K]["Type"];
type Session<K extends keyof typeof sessionParameters> = (typeof sessionParameters)[K]["Type"];
/** The tools that name an issue and nothing else. */
type IssueTool = "check" | "changes" | "stop" | "dismiss";

/** Who is calling, at the moment of the call. */
export interface Caller {
  /** The profile: orchestratorAgent for the orchestrator. */
  readonly agent: string;
  /** The session working as agent, and the project it works in; both empty for the orchestrator. */
  readonly session: string;
  readonly project: string;
  /** The channel the orchestrator is answering. A session's default is its own issue thread, which the channel service knows. */
  readonly here: string;
  /** The profile the owner picked for this input, if any: dispatch prefers it. */
  readonly picked: string;
  /** Who calls, and on whose word: the services judge what it may do by it. */
  readonly actor: Actor;
}

/** A throw here is told to the model as the tool's failure. */
export type Who = () => Caller;

export interface ToolShape {
  /** The orchestrator's tools, in the order its prompt has always listed them: the order is part of the prompt's prefix. */
  readonly orchestrator: (who: Who) => Tool[];
  /** A session's tools, served on /mcp. */
  readonly session: (who: Who) => Tool[];
  /** How a tool call reads in the orchestrator's trajectory: its label and the first naming argument. */
  readonly start: (name: string, args: unknown) => ToolStart;
  readonly sessionLine: (w: Roster) => string;
}

export class Tools extends Context.Service<Tools, ToolShape>()("vibevalley/Tool") {}

const named = ["issue", "agent", "session", "project", "name", "title", "query", "note", "goal"];

export function toolStart(name: string, args: unknown): ToolStart {
  const fields = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  let about = "";
  for (const k of named) {
    const v = fields[k];
    if (typeof v === "string" && v.trim() !== "") {
      about = v;
      break;
    }
  }
  const w = toolWording();
  const label = w.labels[name] ?? name;
  if (about.length > 40) about = head(about, 40) + "…";
  return { text: about ? w.about(label, about) : label, action: "other", tool: name, input: args === undefined || args === null ? "{}" : JSON.stringify(args) };
}

const appendTypes = ["paragraph", "heading", "bulleted", "numbered", "todo", "quote", "code"];

const spaces = /\s+/g;

/** Told to the model as the tool's failed result: the message is what it reads. */
export class ToolRefusal extends Data.TaggedError("ToolRefusal")<{ readonly message: string }> {}

const refuse = (message: string) => Effect.fail(new ToolRefusal({ message }));

/** A failure as the model reads it. */
const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(reasonOf(e as ApiError)));
const said = (e: unknown) => toError(e).message;

/** who throws for a caller nobody knows: the model reads it as the tool's failure. */
const callerOf = (who: Who) => Effect.try({ try: who, catch: (e) => new ToolRefusal({ message: said(e) }) });

export const make = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const agents = yield* Agents;
  const projects = yield* Projects;
  const memory = yield* Memories;
  const docs = yield* Docs;
  const run = yield* Sessions;
  const runtimes = yield* Runtimes;
  const chat = yield* Channels;
  const recurrence = yield* Recurrences;
  const issue = yield* Issues;
  const tasks = yield* Tasks;

  /** An answer, or "没成：" and why. */
  const answered = <E>(e: Effect.Effect<string, E>) => Effect.catch(e, (err) => Effect.succeed(answers.failed(said(err))));

  // A tool's arguments are read by its Schema before it runs; the model's JSON Schema is made from the same one.
  const toolOf =
    <All extends { readonly [name: string]: Schema.Codec<unknown, unknown, never, never> }>(all: All, shown: Record<keyof All & string, JsonSchema>) =>
    <K extends keyof All & string>(name: K, description: string, body: (p: All[K]["Type"]) => Effect.Effect<string, unknown>) => {
      const read: (args: unknown) => Effect.Effect<All[K]["Type"], Schema.SchemaError> = Schema.decodeUnknownEffect<All[K]>(all[name]);
      return effectTool<unknown>({ name, description, parameters: shown[name], run: (args) => Effect.mapError(Effect.flatMap(read(args), body), toError) });
    };
  const tool = toolOf(parameters, schemas);
  const sessionSchemaTool = toolOf(sessionParameters, sessionSchemas);

  // The orchestrator may name a session by its id, its name, or words that contain its name.
  const findSession = (key: string) => {
    const all = run.roster();
    return all.find((w) => w.session.id === key) ?? all.find((w) => w.session.name === key) ?? all.find((w) => key.includes(w.session.name));
  };

  // The orchestrator names an issue by its number (#41, 41), its id, or the name or id of a helper working it.
  const findIssue = Effect.fnUntraced(function* (key: string): Effect.fn.Return<Issue | string> {
    const k = key.trim().replace(/^#/, "");
    const all = yield* issue.list();
    if (/^\d+$/.test(k)) return all.find((t) => t.number === Number(k)) ?? answers.noIssueNumber(k);
    const byId = all.find((t) => t.id === k);
    if (byId) return byId;
    const w = findSession(k);
    const of = w?.session.issue ? all.find((t) => t.id === w.session.issue) : undefined;
    return of ?? answers.noIssueOrAgent(k);
  });
  const withIssue = <E>(key: string, f: (t: Issue) => Effect.Effect<string, E>) =>
    Effect.flatMap(findIssue(key), (t) => (typeof t === "string" ? Effect.succeed(t) : f(t)));
  const issueTool = <E>(name: IssueTool, description: string, f: (t: Issue) => Effect.Effect<string, E>) =>
    tool(name, description, (p) => withIssue(p.issue, f));
  /** The helper on the farm working the issue now, if any: its newest session. */
  const workerOf = (t: Issue) => {
    const last = t.sessions.at(-1);
    return last === undefined ? undefined : run.roster().find((w) => w.session.id === last);
  };
  const whoOf = (t: Issue) =>
    workerOf(t)?.session.name ??
    (t.assignee === orchestratorAgent ? ownerAgentWord : t.assignee ? (agents.agents().find((a) => a.id === t.assignee)?.name ?? "") : "");
  const nobodyOn = (t: Issue) => answers.nobodyOn(t.number);
  const numberOf = (w: Roster) => (w.session.issue ? issue.onBoard().find((t) => t.id === w.session.issue)?.number : undefined);

  // Who reads and speaks in a channel: a session as itself, the orchestrator as the orchestrator.
  const participant = (c: Caller) => c.session || c.agent;

  // Which profile takes a task: the one named (a profile's name or id, or a runtime), else the one the owner picked for
  // this input, else by the farm's rule. A name that matches none is said, not taken for "anyone".
  const choose = Effect.fnUntraced(function* (task: string, name: string, picked: string): Effect.fn.Return<Agent | string> {
    const key = name.trim();
    const a = yield* runtimes.choose(task, key, picked);
    if (!a) return answers.noAgentToDispatch;
    if (key && a.id !== key && a.name !== key && a.runtime !== key) return answers.noAgentOrRuntime(key);
    return a;
  });

  // The orchestrator may say a profile's name or id.
  const profile = (key: string): Effect.Effect<string, ToolRefusal> => {
    const k = key.trim();
    if (k === orchestratorAgent || k === ownerAgentWord) return refuse(answers.rememberOwnNote);
    const a = agents.named(k);
    return a ? Effect.succeed(a.id) : refuse(answers.noProfileNamed(k));
  };
  const notWorking = answers.notWorking;

  const query = (q: Partial<SearchQuery>): SearchQuery => ({ agent: "", project: "", text: "", kind: "", limit: 0, ...q });

  const projectsTool = tool(
    "projects",
    descriptions.projects,
    Effect.fn("Tools.projects")(function* () {
      const all = yield* projects.list();
      if (all.length === 0) return answers.projects.empty(projects.root);
      return all.map((p) => "- " + p.name + (p.git ? "" : answers.projects.notGitYet)).join("\n");
    }),
  );

  const channelsTool = tool(
    "channels",
    descriptions.channels,
    Effect.fn("Tools.channels")(function* () {
      return (yield* chat.channels()).map((c) => "- " + channelLine(c)).join("\n");
    }),
  );

  const roster = tool("roster", descriptions.roster, () =>
    Effect.sync(() => {
      const all = run.roster();
      return all.length === 0 ? answers.roster.empty : all.map((w) => sessionLine(w, clock.currentTimeMillisUnsafe(), numberOf(w))).join("\n");
    }),
  );

  const check = issueTool(
    "check",
    descriptions.check,
    Effect.fn("Tools.check")(function* (t: Issue) {
      const w = workerOf(t);
      const timeline = yield* Effect.orElseSucceed(issue.timeline(t.id), () => undefined);
      const lines = [issueDetail(t, whoOf(t), timeline, clock.currentTimeMillisUnsafe())];
      if (w) lines.push(sessionLine(w, clock.currentTimeMillisUnsafe(), t.number), answers.check.workdir(w.place.cwd), answers.check.lastReport(w.lastText));
      return lines.join("\n");
    }),
  );

  const changes = (who: Who) =>
    issueTool(
      "changes",
      descriptions.changes,
      Effect.fn("Tools.changes")(
        function* (t: Issue) {
          const c = yield* callerOf(who);
          return changesText(yield* issue.changes(t.id, c.actor));
        },
        Effect.catch((e) => Effect.succeed(answers.changes.failed(said(e)))),
      ),
    );

  const sessionList = sessionSchemaTool("session_list", descriptions.sessionList, () =>
    Effect.sync(() => {
      // Listed without @: an @ wakes someone, and models copy what they read.
      const lines = [answers.sessionList.intro];
      for (const h of run.presentSessions())
        lines.push(
          answers.sessionList.row(
            h.id,
            h.name,
            h.runtime,
            h.project ?? "?",
            phaseText(h, clock.currentTimeMillisUnsafe()),
            head(h.brief.replace(spaces, " "), 60),
          ),
        );
      lines.push(answers.sessionList.wake);
      return lines.join("\n");
    }),
  );

  const spokenText = (s: Spoken): string => {
    switch (s.kind) {
      case "held": {
        const shown = s.shown ?? [];
        const more = s.more ?? 0;
        return answers.spoken.held(s.target, shown.length, more, inboxLines(shown));
      }
      case "confirm":
        return answers.spoken.confirm(s.target, s.lastRead);
      default: {
        const absent = s.absent && s.absent.length > 0 ? answers.spoken.absentNote(s.absent.map((m) => "@" + m).join("、")) : "";
        return answers.spoken.sent(s.target, s.message?.number ?? 0, absent);
      }
    }
  };

  const channelSay = (who: Who) =>
    sessionSchemaTool(
      "channel_say",
      descriptions.channelSay,
      Effect.fn("Tools.channel_say")(function* (p: Session<"channel_say">) {
        const c = yield* callerOf(who);
        return spokenText(
          yield* chat.speak(participant(c), p.text, {
            ...(p.target ? { target: p.target } : {}),
            ...(p.anyway ? { anyway: true } : {}),
            ...(p.confirm ? { confirm: true } : {}),
            ...(p.reply !== undefined ? { reply: p.reply } : {}),
          }),
        );
      }),
    );

  const readChat = (who: Who) =>
    tool(
      "read_chat",
      descriptions.readChat,
      Effect.fn("Tools.read_chat")(function* (p: Orchestrator<"read_chat">) {
        const c = yield* callerOf(who);
        let where = p.target ?? "";
        // A session's default is its own thread, which the channel service fills in.
        if (where === "" && c.session === "") where = (yield* chat.addressOf(c.here)).target;
        const read = yield* Effect.result(
          chat.read(participant(c), {
            target: where,
            ...(p.unread ? { unread: true } : {}),
            ...(p.before ? { before: Math.trunc(p.before) } : {}),
            ...(p.limit ? { limit: Math.trunc(p.limit) } : {}),
          }),
        );
        if (read._tag === "Failure") return answers.readChat.failed(said(read.failure));
        const r = read.success;
        if (r.messages.length === 0) return p.unread ? answers.readChat.noUnread(r.target) : answers.readChat.empty(r.target);
        const older = r.older ? answers.readChat.olderNote(r.messages[0]!.number) : "";
        return r.target + older + "：\n" + inboxLines(r.messages);
      }),
    );

  const channelInbox = (who: Who) =>
    sessionSchemaTool(
      "channel_inbox",
      descriptions.channelInbox,
      Effect.fn("Tools.channel_inbox")(function* () {
        const c = yield* callerOf(who);
        const rows = yield* chat.inbox(participant(c));
        if (rows.length === 0) return answers.channelInbox.empty;
        const lines = rows.map((r) => answers.channelInbox.row(r.target, r.unread, r.mentionsYou, r.latest ?? ""));
        lines.push(answers.channelInbox.nextStep(rows[0]!.target));
        return lines.join("\n");
      }),
    );

  // Review is judging what came back against what the issue asked for; a pass only makes it ready, completing it stays
  // the owner's (issue_status to done).
  const accept = tool(
    "accept",
    descriptions.accept,
    Effect.fn("Tools.accept")(function* (p: Orchestrator<"accept">) {
      return yield* withIssue(p.issue, (t) =>
        issue.review(t.id, { pass: p.pass, ...(p.findings ? { findings: p.findings } : {}), ...(p.text ? { text: p.text } : {}) }).pipe(
          Effect.map((done) => (p.pass ? answers.accept.passed(done.number) : answers.accept.failed(done.number, openFindings(done)))),
          Effect.catch((e) => Effect.succeed(said(e))),
        ),
      );
    }),
  );

  const tell = (who: Who) =>
    tool(
      "tell",
      descriptions.tell,
      Effect.fn("Tools.tell")(function* (p: Orchestrator<"tell">) {
        const c = yield* callerOf(who);
        return yield* withIssue(p.issue, (t) => {
          const w = workerOf(t);
          if (!w) return Effect.succeed(nobodyOn(t));
          return chat.tellSession(participant(c), w.session.id, p.message, "").pipe(
            Effect.as(answers.tell.told(t.number, w.session.name)),
            Effect.catch((e) => Effect.succeed(answers.tell.failed(said(e)))),
          );
        });
      }),
    );

  const stop = (who: Who) =>
    issueTool(
      "stop",
      descriptions.stop,
      Effect.fn("Tools.stop")(
        function* (t: Issue) {
          yield* callerOf(who);
          yield* issue.stop(t.id);
          return answers.stop.stopped(t.number);
        },
        Effect.catch((e) => Effect.succeed(said(e))),
      ),
    );
  const dismiss = issueTool(
    "dismiss",
    descriptions.dismiss,
    Effect.fn("Tools.dismiss")(function* (t: Issue) {
      const w = workerOf(t);
      if (!w) return nobodyOn(t);
      yield* run.dismiss(w.session.id);
      return answers.dismiss.dismissed(w.session.name, t.number);
    }),
  );

  const issuesTool = tool(
    "issues",
    descriptions.issues,
    Effect.fn("Tools.issues")(function* (p: Orchestrator<"issues">) {
      if (p.issue)
        return yield* withIssue(p.issue, (t) =>
          Effect.map(
            Effect.orElseSucceed(issue.timeline(t.id), () => undefined),
            (timeline) => issueDetail(t, whoOf(t), timeline, clock.currentTimeMillisUnsafe()),
          ),
        );
      const status = p.status ? statusOf(p.status) : undefined;
      if (p.status && !status) return noSuchStatus(p.status, IssueStatusValues);
      const words = (p.text ?? "").split(spaces).filter(Boolean);
      const now = clock.currentTimeMillisUnsafe();
      let found = (yield* issue.list()).filter(
        (t) =>
          (status ? t.status === status : p.closed || (t.status !== "done" && t.status !== "canceled")) &&
          (!p.wants_owner || attentionWantsOwner(t.attention.state)) &&
          (!p.project || t.project === p.project.trim()) &&
          words.every((w) => (t.title + "\n" + (t.description ?? "")).includes(w)),
      );
      if (p.wants_owner) found = found.sort((a, b) => (a.attention.since ?? now) - (b.attention.since ?? now));
      if (found.length === 0) return p.wants_owner ? answers.issues.noneWaiting : answers.issues.none;
      const limit = p.limit && p.limit > 0 ? Math.trunc(p.limit) : 20;
      const more = found.length > limit ? answers.issues.moreNote(found.length - limit) : "";
      return (
        found
          .slice(0, limit)
          .map((t) => issueLine(t, whoOf(t), now))
          .join("\n") + more
      );
    }),
  );

  const issueCreate = (who: Who) =>
    tool(
      "issue_create",
      descriptions.issueCreate,
      Effect.fn("Tools.issue_create")(function* (p: Orchestrator<"issue_create">) {
        const c = yield* callerOf(who);
        if (p.draft && p.start) return answers.issueCreate.draftWithStartRefused;
        let channel: Info;
        if (p.channel) {
          const byName = yield* chat.channelByName(p.channel);
          if (!byName) return answers.issueCreate.noChannel(p.channel);
          channel = byName;
        } else channel = yield* chat.topOf(c.here);
        const project = (p.project ?? "").trim() || channel.project;
        if (p.start && !project) return answers.issueCreate.noDefaultProject(channel.name);
        const priority = p.priority ? priorityOf(p.priority) : undefined;
        if (p.priority && !priority) return noSuchPriority(p.priority);
        const deliver = p.deliver ? DeliverableValues.find((d) => d === p.deliver) : undefined;
        if (p.deliver && !deliver) return answers.issueCreate.noDeliver;
        let assignee: string | undefined;
        if (p.agent || p.start) {
          const a = yield* choose(p.title + "\n" + (p.description ?? ""), p.agent ?? "", p.start ? c.picked : "");
          if (typeof a === "string") return answers.issueCreate.notRecorded(a);
          assignee = a.id;
        }
        const added = yield* Effect.result(
          issue.add({
            title: p.title,
            ...(p.description ? { description: p.description } : {}),
            ...(project ? { project } : {}),
            ...(assignee ? { assignee } : {}),
            ...(priority ? { priority } : {}),
            ...(deliver ? { deliver } : {}),
          }),
        );
        if (added._tag === "Failure") return answers.issueCreate.notRecordedFailed(said(added.failure));
        const t = added.success;
        const noted = answers.issueCreate.noted(t.number, shortTitle(t.title), t.deliver === "answer");
        if (p.start) {
          // Written down first: a start that fails leaves the issue in the backlog, and trying again starts it, not a second one.
          const started = yield* Effect.result(issue.start(t.id, channel.id));
          if (started._tag === "Failure") return answers.issueCreate.queuedNoStart(noted, said(started.failure));
          const sent = started.success;
          if (sent.queued) return answers.issueCreate.queuedInChannel(noted, channel.name, sent.queued);
          const h = sent.session ? run.find(sent.session)?.session : undefined;
          const branch = h?.branch ? answers.issueCreate.branchNote(h.branch) : "";
          return answers.issueCreate.dispatched(
            noted,
            channel.name,
            h ? h.name + "（" + h.id + "）" : answers.issueCreate.noAgentFallback,
            h?.project ?? project,
            branch,
          );
        }
        if (!p.draft) return answers.issueCreate.inBacklog(noted, answers.issueCreate.notStartedNote);
        const refined = yield* issue.refine(t.id, [p.title, p.description ?? ""].join("\n").trim(), channel.id).pipe(
          Effect.as(answers.issueCreate.draftingNote),
          Effect.catch((e) => Effect.succeed(answers.issueCreate.draftFailed(said(e)))),
        );
        return answers.issueCreate.inBacklog(noted, refined);
      }),
    );

  const issueUpdate = (who: Who) =>
    tool(
      "issue_update",
      descriptions.issueUpdate,
      Effect.fn("Tools.issue_update")(function* (p: Orchestrator<"issue_update">) {
        const c = yield* callerOf(who);
        return yield* withIssue(p.issue, (t) => {
          const priority = p.priority ? priorityOf(p.priority) : undefined;
          if (p.priority && !priority) return Effect.succeed(noSuchPriority(p.priority));
          let assignee: string | undefined;
          if (p.agent) {
            const a = agents.named(p.agent);
            if (!a) return Effect.succeed(answers.noProfileNamed(p.agent));
            assignee = a.id;
          }
          return issue
            .edit(
              t.id,
              {
                ...(p.title !== undefined ? { title: p.title } : {}),
                ...(p.description !== undefined ? { description: p.description } : {}),
                ...(p.project !== undefined ? { project: p.project } : {}),
                ...(assignee ? { assignee } : {}),
                ...(priority ? { priority } : {}),
                ...(p.deliver ? { deliver: p.deliver } : {}),
                ...(p.criteria !== undefined ? { criteria: p.criteria } : {}),
              },
              c.actor,
            )
            .pipe(
              Effect.map((done) => answers.issueUpdate.updated(issueLine(done, whoOf(done), clock.currentTimeMillisUnsafe()).slice(2))),
              Effect.catch((e) => Effect.succeed(answers.issueUpdate.failed(said(e)))),
            );
        });
      }),
    );

  const issueStatus = (who: Who) =>
    tool(
      "issue_status",
      descriptions.issueStatus,
      Effect.fn("Tools.issue_status")(function* (p: Orchestrator<"issue_status">) {
        const c = yield* callerOf(who);
        const to = statusOf(p.to);
        if (!to) return noSuchStatus(p.to, ["backlog", "todo", "done", "canceled"]);
        return yield* withIssue(
          p.issue,
          Effect.fnUntraced(
            function* (t: Issue) {
              // Sent out with nobody named yet: chosen by the farm's rule, the owner's pick first; another one named hands it over.
              let agent: string | undefined;
              if (p.agent || (to === "todo" && t.status === "backlog" && !t.assignee)) {
                const chosen = yield* choose(t.title + "\n" + (t.description ?? ""), p.agent ?? "", p.agent ? "" : c.picked);
                if (typeof chosen === "string") return answers.issueStatus.notMoved(chosen);
                agent = chosen.id;
              }
              const done = yield* issue.setStatus(t.id, to, p.text ?? "", c.here, c.actor, agent ? { agent } : {});
              // Completing says what it delivered, which follows the issue: merged, no change, its branch kept, or a PR still open.
              if (to === "done" && done.status === "done") return `#${done.number} ${closedText(done)}`;
              if (to === "done" && done.pullRequest?.state === "open") return answers.issueStatus.prOpenNote(done.number, done.pullRequest.url);
              return answers.issueStatus.moved(issueLine(done, whoOf(done), clock.currentTimeMillisUnsafe()).slice(2));
            },
            Effect.catch((e) => Effect.succeed(answers.issueStatus.notMoved(said(e)))),
          ),
        );
      }),
    );

  const recurrenceTool = (who: Who) =>
    tool(
      "recurrence",
      descriptions.recurrence,
      Effect.fn("Tools.recurrence")(
        function* (p: Orchestrator<"recurrence">) {
          const c = yield* callerOf(who);
          let channel = yield* chat.topOf(c.here);
          if (p.channel) {
            const byName = yield* chat.channelByName(p.channel);
            if (!byName) return yield* refuse(answers.recurrence.noChannelShort(p.channel));
            channel = byName;
          }
          let when: RecurrenceWhen;
          switch (p.kind) {
            case "once": {
              const at = parseTime(p.at ?? "");
              if (at === undefined) return yield* refuse(answers.recurrence.badTime(p.at ?? ""));
              when = { kind: "once", at };
              break;
            }
            case "every":
              when = { kind: "every", minutes: p.minutes ?? 0 };
              break;
            case "daily":
              when = { kind: "daily", time: p.time ?? "" };
              break;
            case "cron":
              when = { kind: "cron", expr: p.cron ?? "" };
              break;
            default:
              when = { kind: "weekly", days: (p.days ?? []).map((d) => Math.trunc(d)), time: p.time ?? "" };
          }
          const made = yield* recurrence.add(
            {
              name: p.name,
              text: p.text,
              channel: channel.id,
              when,
              ...(p.agent ? { agent: p.agent } : {}),
              ...(p.project ? { project: p.project } : {}),
              ...(p.tz ? { tz: p.tz } : {}),
            },
            c.actor,
          );
          if (made.pending) return answers.recurrence.pending(recurrenceLine(made, channel.name));
          return answers.recurrence.confirmed(recurrenceLine(made, channel.name));
        },
        (e) => answered(e),
      ),
    );

  const listRecurrences = tool(
    "list_recurrences",
    descriptions.listRecurrences,
    Effect.fn("Tools.list_recurrences")(function* () {
      const all = recurrence.list();
      if (all.length === 0) return answers.listRecurrences.none;
      const names = new Map((yield* chat.channels()).map((c) => [c.id, c.name]));
      return all.map((s) => recurrenceLine(s, names.get(s.channel) ?? "?")).join("\n");
    }),
  );

  const cancelRecurrence = tool("cancel_recurrence", descriptions.cancelRecurrence, (p: Orchestrator<"cancel_recurrence">) =>
    answered(Effect.map(recurrence.remove(p.id), (s) => answers.cancelRecurrence.canceled(s.name))),
  );

  const openChannel = tool(
    "open_channel",
    descriptions.openChannel,
    Effect.fn("Tools.open_channel")(function* (p: Orchestrator<"open_channel">) {
      const c = yield* chat.openChannel(p.name, p.description ?? "", p.project ?? "");
      return answers.openChannel.opened(c.name, c.project);
    }),
  );

  const channelSettings = tool(
    "channel_settings",
    descriptions.channelSettings,
    Effect.fn("Tools.channel_settings")(function* (p: Orchestrator<"channel_settings">) {
      const c = yield* chat.channelByName(p.channel);
      if (!c) return yield* refuse(answers.channelSettings.noChannel(p.channel));
      yield* chat.updateChannel(c.id, p.description, p.project);
      return answers.channelSettings.updated(c.name);
    }),
  );

  const graphSplit = (who: Who) =>
    tool(
      "graph_split",
      descriptions.graphSplit,
      Effect.fn("Tools.graph_split")(function* (p: Orchestrator<"graph_split">) {
        const c = yield* callerOf(who);
        return yield* answered(tasks.split(p.goal, p.project, p.agent ?? "", c.actor));
      }),
    );

  const graphsTool = tool("graphs", descriptions.graphs, (p: Orchestrator<"graphs">) =>
    Effect.sync(() => {
      const texts = tasks
        .graphs()
        .filter((g) => (p.id ? g.id === p.id : isOpen(g)))
        .map(graphText);
      if (texts.length > 0) return texts.join("\n\n");
      return p.id ? answers.graphs.noGraphNamed(p.id) : answers.graphs.none;
    }),
  );

  const taskEdit = (who: Who) =>
    tool(
      "task_edit",
      descriptions.taskEdit,
      Effect.fn("Tools.task_edit")(function* (p: Orchestrator<"task_edit">) {
        const by = (yield* callerOf(who)).actor;
        if (p.remove) return yield* answered(tasks.removeTask(p.graph, p.task, by));
        const edit: TaskEdit = {
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.brief !== undefined ? { brief: p.brief } : {}),
          ...(p.needs !== undefined ? { needs: p.needs } : {}),
          ...(p.agent !== undefined ? { agent: p.agent } : {}),
          ...(p.check !== undefined ? { check: p.check } : {}),
        };
        return yield* answered(tasks.editTask(p.graph, p.task, edit, by));
      }),
    );

  const graphAction = (who: Who) =>
    tool(
      "graph_action",
      descriptions.graphAction,
      Effect.fn("Tools.graph_action")(function* (p: Orchestrator<"graph_action">) {
        const c = yield* callerOf(who);
        return yield* answered(tasks.act(p.graph, p.action, c.actor));
      }),
    );

  const taskAction = (who: Who) =>
    tool(
      "task_action",
      descriptions.taskAction,
      Effect.fn("Tools.task_action")(function* (p: Orchestrator<"task_action">) {
        const c = yield* callerOf(who);
        return yield* answered(tasks.taskAct(p.graph, p.task, p.action, c.actor));
      }),
    );

  const issueSplit = (who: Who) =>
    sessionSchemaTool(
      "issue_split",
      descriptions.issueSplit(maxTasks),
      Effect.fn("Tools.issue_split")(function* (p: Session<"issue_split">) {
        const c = yield* callerOf(who);
        const steps = (p.tasks ?? []).map((t) => ({
          id: t.id,
          title: t.title ?? "",
          brief: t.brief,
          ...(t.needs ? { needs: t.needs } : {}),
          agent: t.agent ?? "",
          check: t.check ?? "",
          ...(t.scope ? { scope: t.scope } : {}),
          ...(t.acceptance ? { acceptance: true } : {}),
        }));
        return yield* answered(tasks.splitIssue(c.session, p.title ?? "", steps));
      }),
    );

  const memorySearch = (who: Who, forOrchestrator: boolean) =>
    forOrchestrator
      ? tool(
          "memory_search",
          descriptions.memorySearchOrchestrator,
          Effect.fn("Tools.memory_search")(function* (p: Orchestrator<"memory_search">) {
            const agent = (p.agent ?? "").trim() ? yield* profile(p.agent!) : "";
            const q = query({ text: p.query ?? "", project: (p.project ?? "").trim(), ...(agent ? { agent } : {}) });
            return foundText(yield* memory.search(q), q);
          }, answered),
        )
      : sessionSchemaTool(
          "memory_search",
          descriptions.memorySearchSession,
          Effect.fn("Tools.memory_search")(function* (p: Session<"memory_search">) {
            const c = yield* callerOf(who);
            if (!c.agent) return yield* refuse(notWorking);
            const q = query({ agent: c.agent, project: p.all_projects ? "" : c.project, text: p.query ?? "" });
            return foundText(yield* memory.search(q), q);
          }),
        );

  const memoryAdd = (who: Who, forOrchestrator: boolean) =>
    forOrchestrator
      ? tool(
          "memory_add",
          descriptions.memoryAddOrchestrator,
          Effect.fn("Tools.memory_add")(function* (p: Orchestrator<"memory_add">) {
            const id = yield* profile(p.agent);
            const c = yield* callerOf(who);
            const m = yield* memory.remember({ agent: id, text: p.text, project: p.project ?? "", by: c.actor });
            return answers.memory.rememberedFor(id, memoryWhere(m), m.id);
          }, answered),
        )
      : sessionSchemaTool(
          "memory_add",
          descriptions.memoryAddSession,
          Effect.fn("Tools.memory_add")(function* (p: Session<"memory_add">) {
            const c = yield* callerOf(who);
            if (!c.agent) return yield* refuse(notWorking);
            if (p.agent && p.agent !== c.agent) return yield* refuse(answers.memory.notYourProfile(c.agent, p.agent));
            const m = yield* memory.remember({ agent: c.agent, text: p.text, project: p.all_projects ? "" : c.project, by: c.actor });
            return answers.memory.remembered(memoryWhere(m), m.id);
          }),
        );

  // Documents: a session reads one, appends blocks and rewrites a block's text against the rev it read, through the same
  // op pipeline the owner's editor uses, written as its profile (its session id when it has none).
  const writer = (c: Caller) => c.agent || c.session;

  const docRead = (who: Who) =>
    sessionSchemaTool(
      "doc_read",
      descriptions.docRead,
      Effect.fn("Tools.doc_read")(function* (p: Session<"doc_read">) {
        yield* callerOf(who);
        const snap = yield* docs.get(p.doc.trim());
        return [answers.doc.header(snap.doc.title, snap.blocks.length), ...snap.blocks.map(blockLine)].join("\n");
      }),
    );

  const docAppend = (who: Who) =>
    sessionSchemaTool(
      "doc_append",
      descriptions.docAppend,
      Effect.fn("Tools.doc_append")(function* (p: Session<"doc_append">) {
        const c = yield* callerOf(who);
        const type = (p.type ?? "").trim() || "paragraph";
        if (!appendTypes.includes(type)) return yield* refuse(answers.doc.badBlockType(appendTypes));
        const attrs: BlockAttrs =
          type === "heading" ? { level: p.level && p.level >= 1 && p.level <= 3 ? Math.trunc(p.level) : 2 } : type === "todo" ? { checked: false } : {};
        const [b, r] = yield* docs.append(p.doc.trim(), writer(c), type, attrs, p.text);
        if (!r || r.status !== "applied" || !b) return yield* refuse(r?.reason ?? "");
        return answers.doc.appended(b.id, b.rev);
      }),
    );

  const docUpdate = (who: Who) =>
    sessionSchemaTool(
      "doc_update",
      descriptions.docUpdate,
      Effect.fn("Tools.doc_update")(function* (p: Session<"doc_update">) {
        const c = yield* callerOf(who);
        const [, r] = yield* docs.updateText(p.doc.trim(), writer(c), p.block.trim(), Math.trunc(p.base_rev ?? 0), p.text);
        if (r?.status === "applied") return answers.doc.updated(r.blockId, r.rev);
        if (r?.status === "conflict") {
          const now = yield* Effect.orElseSucceed(docs.get(p.doc.trim()), () => undefined);
          const x = now?.blocks.find((b) => b.id === r.blockId);
          return answers.doc.notUpdated(r.reason, r.rev, x ? blockLine(x) : "");
        }
        return yield* refuse(r?.reason ?? "");
      }),
    );

  return Tools.of({
    orchestrator: (who) => [
      projectsTool,
      channelsTool,
      recurrenceTool(who),
      listRecurrences,
      cancelRecurrence,
      openChannel,
      channelSettings,
      accept,
      changes(who),
      roster,
      check,
      tell(who),
      readChat(who),
      stop(who),
      dismiss,
      issuesTool,
      issueCreate(who),
      issueUpdate(who),
      issueStatus(who),
      graphSplit(who),
      graphsTool,
      taskEdit(who),
      graphAction(who),
      taskAction(who),
      memorySearch(who, true),
      memoryAdd(who, true),
    ],
    session: (who) => [
      channelSay(who),
      readChat(who),
      channelInbox(who),
      sessionList,
      memorySearch(who, false),
      memoryAdd(who, false),
      docRead(who),
      docAppend(who),
      docUpdate(who),
      issueSplit(who),
    ],
    start: toolStart,
    sessionLine: (w) => sessionLine(w, clock.currentTimeMillisUnsafe(), numberOf(w)),
  });
});

export const layer = Layer.effect(Tools, make);
