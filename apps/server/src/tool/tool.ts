// The tools agents call, defined once: the orchestrator gets them in process, a session over /mcp. A
// tool's rule lives in the service that owns it; a tool reads its arguments, says who is calling, and words the answer.
// Every tool answers in a sentence, a refusal included: the model acts on it.

import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { Clock, Context, Effect, Layer, Predicate, Schema } from "effect";

import { ToolFailed } from "@vibevalley/agent/core/errors";
import type { Tool } from "@vibevalley/agent/core/loop";
import { effectTool } from "@vibevalley/agent/core/tool";
import type { JsonSchema } from "@vibevalley/ai/tools";
import { maybe, t } from "@vibevalley/i18n";
import { type Agent, DeliverableValues, type Issue, IssueStatusValues, defaultOrchestrator, type CronWhen, type TaskEdit } from "@vibevalley/protocol";
import { ApiError as ApiErrorSchema } from "@vibevalley/protocol/api";
import { closedText, phaseText, shortTitle } from "@vibevalley/protocol/rules";

import { Agents } from "@/agent/agent.ts";
import { Artifacts } from "@/artifact/artifact.ts";
import { artifactMax } from "@/artifact/policy.ts";
import type { Actor } from "@/base/actor.ts";
import { head } from "@/base/clip.ts";
import { Channels, type Info, type Spoken } from "@/channel/chat.ts";
import { inboxLines } from "@/channel/prompts.ts";
import { Crons } from "@/cron/cron.ts";
import { messageOf, type ApiError, reasonOf, refused } from "@/errors.ts";
import { Issues } from "@/issue/issue.ts";
import { openFindings } from "@/issue/status.ts";
import { foundText, Memories, type SearchQuery } from "@/memory/memory.ts";
import { Projects } from "@/project/project.ts";
import { Runtimes } from "@/runtime/runtime.ts";
import type { ToolStart } from "@/session/facts.ts";
import { type Roster, Sessions } from "@/session/session.ts";
import { isOpen, maxTasks } from "@/task/graph.ts";
import { graphText } from "@/task/prompts.ts";
import { Tasks } from "@/task/task.ts";

import {
  answers,
  blockLine,
  changesText,
  channelLine,
  descriptions,
  sessionDescriptions,
  issueDetail,
  issueLine,
  memoryWhere,
  noSuchPriority,
  noSuchStatus,
  ownerAgentWord,
  parseTime,
  priorityOf,
  cronLine,
  sessionLine,
  statusOf,
} from "./prompts.ts";
import { type Op, parameters, schemas, sessionParameters, sessionSchemas, toolName } from "./schemas.ts";

/** A tool's arguments as its Schema reads them. */
type Orchestrator<K extends keyof typeof parameters> = (typeof parameters)[K]["Type"];
type Session<K extends keyof typeof sessionParameters> = (typeof sessionParameters)[K]["Type"];
/** The tools that name an issue and nothing else. */
type IssueTool = "issue.get" | "issue.diff.get" | "session.stop";

/** Who is calling, at the moment of the call. */
export interface Caller {
  /** The profile: an orchestrator's own id for an orchestrator. */
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

export class Tools extends Context.Service<
  Tools,
  {
    /** The orchestrator's tools, in the order its prompt has always listed them: the order is part of the prompt's prefix. */
    readonly orchestrator: (who: Who) => Tool[];
    /** A session's tools, served on /mcp. */
    readonly session: (who: Who) => Tool[];
    /** How a tool call reads in the orchestrator's trajectory: its label and the first naming argument. */
    readonly start: (name: string, args: unknown) => ToolStart;
    readonly sessionLine: (w: Roster) => string;
  }
>()("vibevalley/Tool") {
  static readonly layer = Layer.effect(
    Tools,
    Effect.suspend(() => make),
  );
}

// The fields that name what a call is about, the first one given wins: an issue's or a channel's id, a profile, a title.
const named = ["id", "agent", "assignee", "session", "project", "name", "title", "text", "note", "goal"];

export function toolStart(name: string, args: unknown): ToolStart {
  let about = "";
  for (const k of named) {
    const v: unknown = Predicate.hasProperty(args, k) ? args[k] : undefined;
    if (typeof v === "string" && v.trim() !== "") {
      about = v;
      break;
    }
  }
  const label = maybe(`server.tool.labels.${name}`) ?? name;
  if (about.length > 40) about = head(about, 40) + "…";
  return {
    text: about ? t("server.tool.about", { label, about }) : label,
    action: "other",
    tool: name,
    input: args === undefined || args === null ? "{}" : JSON.stringify(args),
  };
}

const spaces = /\s+/gu;

/** Told to the model as the tool's failed result: the message is what it reads. */
class ToolRefusal extends Schema.TaggedError<ToolRefusal, { readonly brand: unique symbol }>()("ToolRefusal", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const refuse = (message: string) => Effect.fail(new ToolRefusal({ message }));

/** A failure as the model reads it. */
/** A tool's refusal or failure as the failed result the model reads: an API refusal says its reason. */
const toFailed = (e: unknown): ToolFailed => new ToolFailed({ message: Schema.is(ApiErrorSchema)(e) ? reasonOf(e) : messageOf(e), cause: e });
const said = (e: unknown) => toFailed(e).message;

/** who throws for a caller nobody knows: the model reads it as the tool's failure. */
const callerOf = (who: Who) => Effect.try({ try: who, catch: (e) => new ToolRefusal({ message: said(e), cause: e }) });

const make = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const agents = yield* Agents;
  const projects = yield* Projects;
  const memory = yield* Memories;
  const run = yield* Sessions;
  const runtimes = yield* Runtimes;
  const chat = yield* Channels;
  const cron = yield* Crons;
  const issue = yield* Issues;
  const tasks = yield* Tasks;
  const artifacts = yield* Artifacts;

  /** An answer, or "没成：" and why. */
  const answered = <E>(e: Effect.Effect<string, E>) => Effect.catch(e, (err) => Effect.succeed(answers.failed(said(err))));

  // A tool's arguments are read by its Schema before it runs; the model's JSON Schema is made from the same one.
  // Named by its endpoint (toolName): the name is never written a second time.
  const toolOf =
    <All extends { readonly [op: string]: Schema.Codec<unknown, unknown> }>(all: All, shown: Record<keyof All & string, JsonSchema>) =>
    <K extends keyof All & Op, E>(op: K, description: string, body: (p: All[K]["Type"]) => Effect.Effect<string, E>) => {
      const read: (args: unknown) => Effect.Effect<All[K]["Type"], Schema.SchemaError> = Schema.decodeUnknownEffect<All[K]>(all[op]);
      return effectTool<unknown>({
        name: toolName(op),
        description,
        parameters: shown[op],
        run: (args) => Effect.mapError(Effect.flatMap(read(args), body), toFailed),
      });
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
    const k = key.trim().replace(/^#/u, "");
    const all = yield* issue.list();
    if (/^\d+$/u.test(k)) return all.find((item) => item.number === Number(k)) ?? answers.noIssueNumber(k);
    const byId = all.find((item) => item.id === k);
    if (byId) return byId;
    const w = findSession(k);
    const of = w?.session.issue ? all.find((item) => item.id === w.session.issue) : undefined;
    return of ?? answers.noIssueOrAgent(k);
  });
  const withIssue = <E>(key: string, f: (issue: Issue) => Effect.Effect<string, E>) =>
    // findIssue's text is the refusal the model reads, a result like f's: not a failure to filter out.
    // @effect-diagnostics-next-line flatMapConditionalToFilterOrFail:off
    Effect.flatMap(findIssue(key), (item) => (typeof item === "string" ? Effect.succeed(item) : f(item)));
  const issueTool = <E>(op: IssueTool, f: (issue: Issue) => Effect.Effect<string, E>) => tool(op, descriptions[op], (p) => withIssue(p.id, f));
  /** The helper on the farm working the issue now, if any: its newest session. */
  const workerOf = (issue: Issue) => {
    const last = issue.sessions.at(-1);
    return last === undefined ? undefined : run.roster().find((w) => w.session.id === last);
  };
  const whoOf = (issue: Issue) =>
    workerOf(issue)?.session.name ??
    (issue.assignee === defaultOrchestrator ? ownerAgentWord : issue.assignee ? (agents.agent(issue.assignee)?.name ?? "") : "");
  const nobodyOn = (issue: Issue) => answers.nobodyOn(issue.number);
  const numberOf = (w: Roster) => (w.session.issue ? issue.onBoard().find((item) => item.id === w.session.issue)?.number : undefined);

  // Who reads and speaks in a channel: a session as itself, the orchestrator as the orchestrator.
  const participant = (c: Caller) => c.session || c.agent;

  // Which profile takes a brief: the one named (a profile's name or id, or a runtime), else the one the owner picked for
  // this input, else by the farm's rule. A name that matches none is said, not taken for "anyone".
  const choose = Effect.fnUntraced(function* (brief: string, name: string, picked: string): Effect.fn.Return<Agent | string> {
    const key = name.trim();
    const a = yield* runtimes.choose(brief, key, picked);
    if (!a) return answers.noAgentToDispatch;
    if (key && a.id !== key && a.name !== key && a.runtime !== key) return answers.noAgentOrRuntime(key);
    return a;
  });

  // The orchestrator may say a profile's name or id.
  const profile = (key: string): Effect.Effect<string, ToolRefusal> => {
    const k = key.trim();
    if (k === ownerAgentWord) return refuse(answers.rememberOwnNote);
    const a = agents.named(k) ?? agents.agent(k) ?? agents.orchestrators().find((o) => o.name === k);
    if (a && agents.isOrchestrator(a.id)) return refuse(answers.rememberOwnNote);
    return a ? Effect.succeed(a.id) : refuse(answers.noProfileNamed(k));
  };
  const notWorking = answers.notWorking;

  const query = (q: Partial<SearchQuery>): SearchQuery => ({ agent: "", project: "", text: "", kind: "", limit: 0, ...q });

  const projectList = tool(
    "project.list",
    descriptions["project.list"],
    Effect.fn("Tools.projectList")(function* () {
      const all = yield* projects.list();
      if (all.length === 0) return answers.projects.empty(projects.root);
      return all.map((p) => "- " + p.name + (p.git ? "" : answers.projects.notGitYet)).join("\n");
    }),
  );

  const channelList = tool(
    "channel.list",
    descriptions["channel.list"],
    Effect.fn("Tools.channelList")(function* () {
      return (yield* chat.channels()).map((c) => "- " + channelLine(c)).join("\n");
    }),
  );

  const roster = tool("session.list", descriptions["session.list"], () =>
    Effect.sync(() => {
      const all = run.roster();
      return all.length === 0 ? answers.roster.empty : all.map((w) => sessionLine(w, clock.currentTimeMillisUnsafe(), numberOf(w))).join("\n");
    }),
  );

  const issueGet = issueTool(
    "issue.get",
    Effect.fn("Tools.issueGet")(function* (item: Issue) {
      const w = workerOf(item);
      const timeline = yield* Effect.orElseSucceed(issue.timeline(item.id), () => undefined);
      const lines = [issueDetail(item, whoOf(item), timeline, clock.currentTimeMillisUnsafe())];
      if (w) lines.push(sessionLine(w, clock.currentTimeMillisUnsafe(), item.number), answers.check.workdir(w.place.cwd), answers.check.lastReport(w.lastText));
      return lines.join("\n");
    }),
  );

  const issueDiff = (who: Who) =>
    issueTool(
      "issue.diff.get",
      Effect.fn("Tools.issueDiff")(
        function* (item: Issue) {
          const c = yield* callerOf(who);
          return changesText(yield* issue.changes(item.id, c.actor));
        },
        Effect.catch((e) => Effect.succeed(answers.changes.failed(said(e)))),
      ),
    );

  const sessionList = sessionSchemaTool("session.list", sessionDescriptions["session.list"], () =>
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
        const absent = s.absent && s.absent.length > 0 ? answers.spoken.absentNote(s.absent) : "";
        return answers.spoken.sent(s.target, s.message?.number ?? 0, absent);
      }
    }
  };

  const messageSend = (who: Who) =>
    sessionSchemaTool(
      "channel.message.send",
      sessionDescriptions["channel.message.send"],
      Effect.fn("Tools.messageSend")(function* (p: Session<"channel.message.send">) {
        const c = yield* callerOf(who);
        return spokenText(
          yield* chat.speak(participant(c), p.text, {
            ...(p.id ? { target: p.id } : {}),
            ...(p.anyway === true ? { anyway: true } : {}),
            ...(p.confirm === true ? { confirm: true } : {}),
            ...(p.replyTo !== undefined ? { reply: p.replyTo } : {}),
          }),
        );
      }),
    );

  const messageList = (who: Who) =>
    tool(
      "channel.message.list",
      descriptions["channel.message.list"],
      Effect.fn("Tools.messageList")(function* (p: Orchestrator<"channel.message.list">) {
        const c = yield* callerOf(who);
        let where = p.id ?? "";
        // A session's default is its own thread, which the channel service fills in.
        if (where === "" && c.session === "") where = (yield* chat.addressOf(c.here)).target;
        const read = yield* Effect.result(
          chat.read(participant(c), {
            target: where,
            ...(p.unread === true ? { unread: true } : {}),
            ...(p.before != null && p.before !== 0 ? { before: Math.trunc(p.before) } : {}),
            ...(p.limit != null && p.limit !== 0 ? { limit: Math.trunc(p.limit) } : {}),
          }),
        );
        if (read._tag === "Failure") return answers.readChat.failed(said(read.failure));
        const r = read.success;
        if (r.messages.length === 0) return p.unread === true ? answers.readChat.noUnread(r.target) : answers.readChat.empty(r.target);
        const older = r.older ? answers.readChat.olderNote(r.messages[0]!.number) : "";
        return answers.readChat.head(r.target, older) + inboxLines(r.messages);
      }),
    );

  const unreadList = (who: Who) =>
    sessionSchemaTool(
      "channel.unread.list",
      sessionDescriptions["channel.unread.list"],
      Effect.fn("Tools.unreadList")(function* () {
        const c = yield* callerOf(who);
        const rows = yield* chat.unread(participant(c));
        if (rows.length === 0) return answers.channelInbox.empty;
        const lines = rows.map((r) => answers.channelInbox.row(r.channel, r.unread, r.mentionsYou, r.latest ?? ""));
        lines.push(answers.channelInbox.nextStep(rows[0]!.channel));
        return lines.join("\n");
      }),
    );

  // Review is judging what came back against what the issue asked for; a pass only makes it ready, completing it stays
  // the owner's (issue_status_update to done).
  const issueReview = tool(
    "issue.review",
    descriptions["issue.review"],
    Effect.fn("Tools.issueReview")(function* (p: Orchestrator<"issue.review">) {
      return yield* withIssue(p.id, (item) =>
        issue.review(item.id, { pass: p.pass, ...(p.findings ? { findings: p.findings } : {}), ...(p.text ? { text: p.text } : {}) }).pipe(
          Effect.map((done) => (p.pass ? answers.accept.passed(done.number) : answers.accept.failed(done.number, openFindings(done)))),
          Effect.catch((e) => Effect.succeed(said(e))),
        ),
      );
    }),
  );

  const issueComment = (who: Who) =>
    tool(
      "issue.comment.create",
      descriptions["issue.comment.create"],
      Effect.fn("Tools.issueComment")(function* (p: Orchestrator<"issue.comment.create">) {
        const c = yield* callerOf(who);
        return yield* withIssue(p.id, (item) => {
          const w = workerOf(item);
          if (!w) return Effect.succeed(nobodyOn(item));
          return chat.tellSession(participant(c), w.session.id, p.text, "").pipe(
            Effect.as(answers.tell.told(item.number, w.session.name)),
            Effect.catch((e) => Effect.succeed(answers.tell.failed(said(e)))),
          );
        });
      }),
    );

  // Artifacts (artifact/): the orchestrator's and a session's take the same endpoints; a session's are made for its issue
  // and announced in its issue thread, the orchestrator's where it is answering.
  const artifactSaid = (e: Effect.Effect<string, ApiError>) => Effect.catch(e, (err) => Effect.succeed(answers.failed(reasonOf(err))));

  /** A version's words: given as they are, or read from a file in the session's working directory. The path is resolved
   * with its links, so neither .. nor a link leads out of the directory. */
  const artifactWords = (c: Caller, content: string | undefined, file: string | undefined) =>
    Effect.gen(function* () {
      if (content !== undefined && file !== undefined) return yield* Effect.fail(refused(answers.artifact.both));
      if (content !== undefined) return content;
      if (file === undefined || file.trim() === "") return yield* Effect.fail(refused(answers.artifact.noContent));
      const cwd = c.session ? run.find(c.session)?.place.cwd : undefined;
      if (!cwd) return yield* Effect.fail(refused(answers.artifact.noPlace));
      const unread = (e: unknown) => refused(messageOf(e));
      const root = yield* Effect.tryPromise({ try: () => realpath(cwd), catch: unread });
      const full = yield* Effect.tryPromise({ try: () => realpath(resolve(root, file)), catch: () => refused(answers.artifact.notFile(file)) });
      if (full !== root && !full.startsWith(root + sep)) return yield* Effect.fail(refused(answers.artifact.outside(file)));
      const info = yield* Effect.tryPromise({ try: () => stat(full), catch: unread });
      if (!info.isFile()) return yield* Effect.fail(refused(answers.artifact.notFile(file)));
      // Read whole only when it may be kept; a bigger one is refused by its size as artifact.create would.
      if (info.size > artifactMax) return "x".repeat(artifactMax + 1);
      return yield* Effect.tryPromise({ try: () => readFile(full, "utf8"), catch: unread });
    });

  const artifactList = (who: Who) =>
    tool(
      "artifact.list",
      descriptions["artifact.list"],
      Effect.fn("Tools.artifactList")(function* (p: Orchestrator<"artifact.list">) {
        yield* callerOf(who);
        let issueId: string | undefined;
        if (p.issue) {
          const item = yield* findIssue(p.issue);
          if (typeof item === "string") return item;
          issueId = item.id;
        }
        const channel = p.channel ? yield* Effect.result(chat.placeOf("", p.channel)) : undefined;
        if (channel?._tag === "Failure") return answers.failed(reasonOf(channel.failure));
        const all = yield* artifacts.list({ ...(issueId ? { issue: issueId } : {}), ...(channel ? { channel: channel.success } : {}) });
        return all.length === 0 ? answers.artifact.none : all.map(answers.artifact.line).join("\n");
      }),
    );
  const sessionArtifactList = (who: Who) =>
    sessionSchemaTool(
      "artifact.list",
      sessionDescriptions["artifact.list"],
      Effect.fn("Tools.artifactList")(function* (p: Session<"artifact.list">) {
        const c = yield* callerOf(who);
        const own = run.sessionOf(c.session)?.issue;
        const channel = p.channel ? yield* Effect.result(chat.placeOf(c.session, p.channel)) : undefined;
        if (channel?._tag === "Failure") return answers.failed(reasonOf(channel.failure));
        const all = yield* artifacts.list(channel ? { channel: channel.success } : own ? { issue: own } : {});
        return all.length === 0 ? answers.artifact.none : all.map(answers.artifact.line).join("\n");
      }),
    );
  const artifactGet = (table: "orchestrator" | "session") => (who: Who) =>
    (table === "orchestrator" ? tool : sessionSchemaTool)(
      "artifact.get",
      (table === "orchestrator" ? descriptions : sessionDescriptions)["artifact.get"],
      Effect.fn("Tools.artifactGet")(function* (p: { readonly id: string }) {
        yield* callerOf(who);
        return yield* artifactSaid(Effect.map(artifacts.get(p.id.trim()), answers.artifact.detail));
      }),
    );
  const artifactContent = (table: "orchestrator" | "session") => (who: Who) =>
    (table === "orchestrator" ? tool : sessionSchemaTool)(
      "artifact.content.get",
      (table === "orchestrator" ? descriptions : sessionDescriptions)["artifact.content.get"],
      Effect.fn("Tools.artifactContent")(function* (p: { readonly id: string; readonly version?: number }) {
        yield* callerOf(who);
        return yield* artifactSaid(
          Effect.flatMap(artifacts.get(p.id.trim()), (a) =>
            a.body === "blocks"
              ? Effect.map(artifacts.blocks(a.id), (snap) => [answers.block.header(a.title, snap.blocks.length), ...snap.blocks.map(blockLine)].join("\n"))
              : Effect.map(artifacts.content(a.id, p.version), (c) => answers.artifact.content(a.title, c.version, c.content)),
          ),
        );
      }),
    );
  const artifactCreate = (who: Who) =>
    tool(
      "artifact.create",
      descriptions["artifact.create"],
      Effect.fn("Tools.artifactCreate")(function* (p: Orchestrator<"artifact.create">) {
        const c = yield* callerOf(who);
        let issueId: string | undefined;
        if (p.issue) {
          const item = yield* findIssue(p.issue);
          if (typeof item === "string") return item;
          issueId = item.id;
        }
        return yield* artifactSaid(
          Effect.gen(function* () {
            const content = yield* artifactWords(c, p.content, undefined);
            const made = yield* artifacts.create(
              { from: c.agent, by: c.agent },
              {
                title: p.title,
                kind: p.kind,
                content,
                ...(p.note ? { note: p.note } : {}),
                channel: p.channel ?? c.here,
                ...(issueId ? { issue: issueId } : {}),
              },
            );
            return answers.artifact.made(made);
          }),
        );
      }),
    );
  const sessionArtifactCreate = (who: Who) =>
    sessionSchemaTool(
      "artifact.create",
      sessionDescriptions["artifact.create"],
      Effect.fn("Tools.artifactCreate")(function* (p: Session<"artifact.create">) {
        const c = yield* callerOf(who);
        const own = run.sessionOf(c.session)?.issue;
        return yield* artifactSaid(
          Effect.gen(function* () {
            const content = yield* artifactWords(c, p.content, p.file);
            const made = yield* artifacts.create(
              { from: c.session, by: c.agent },
              { title: p.title, kind: p.kind, content, ...(p.note ? { note: p.note } : {}), ...(own ? { issue: own } : {}) },
            );
            return answers.artifact.made(made);
          }),
        );
      }),
    );
  const artifactVersion = (table: "orchestrator" | "session") => (who: Who) =>
    (table === "orchestrator" ? tool : sessionSchemaTool)(
      "artifact.version.create",
      (table === "orchestrator" ? descriptions : sessionDescriptions)["artifact.version.create"],
      Effect.fn("Tools.artifactVersion")(function* (p: { readonly id: string; readonly content?: string; readonly file?: string; readonly note?: string }) {
        const c = yield* callerOf(who);
        return yield* artifactSaid(
          Effect.gen(function* () {
            const content = yield* artifactWords(c, p.content, p.file);
            const made = yield* artifacts.version(
              { from: c.session || c.agent, by: c.agent },
              { id: p.id.trim(), content, ...(p.note ? { note: p.note } : {}) },
            );
            return answers.artifact.versioned(made);
          }),
        );
      }),
    );

  const sessionStop = (who: Who) =>
    issueTool(
      "session.stop",
      Effect.fn("Tools.sessionStop")(
        function* (item: Issue) {
          yield* callerOf(who);
          yield* issue.stop(item.id);
          return answers.stop.stopped(item.number);
        },
        Effect.catch((e) => Effect.succeed(said(e))),
      ),
    );
  const issueList = tool(
    "issue.list",
    descriptions["issue.list"],
    Effect.fn("Tools.issueList")(function* (p: Orchestrator<"issue.list">) {
      const status = p.status ? statusOf(p.status) : undefined;
      if (p.status && !status) return noSuchStatus(p.status, IssueStatusValues);
      const { limit: _, status: __, ...rest } = p;
      const found = yield* issue.query({ ...rest, ...(status ? { status } : {}) });
      if (found.length === 0) return p.wantsOwner === true ? answers.issues.noneWaiting : answers.issues.none;
      const now = clock.currentTimeMillisUnsafe();
      const limit = p.limit != null && p.limit > 0 ? Math.trunc(p.limit) : 20;
      const more = found.length > limit ? answers.issues.moreNote(found.length - limit) : "";
      return (
        found
          .slice(0, limit)
          .map((item) => issueLine(item, whoOf(item), now))
          .join("\n") + more
      );
    }),
  );

  const issueCreate = (who: Who) =>
    tool(
      "issue.create",
      descriptions["issue.create"],
      Effect.fn("Tools.issueCreate")(function* (p: Orchestrator<"issue.create">) {
        const c = yield* callerOf(who);
        if (p.draft === true && p.start === true) return answers.issueCreate.draftWithStartRefused;
        let channel: Info;
        if (p.channel) {
          const byName = yield* chat.channelByName(p.channel);
          if (!byName) return answers.issueCreate.noChannel(p.channel);
          channel = byName;
        } else channel = yield* chat.topOf(c.here);
        const project = (p.project ?? "").trim() || channel.project;
        if (p.start === true && !project) return answers.issueCreate.noDefaultProject(channel.name);
        const priority = p.priority ? priorityOf(p.priority) : undefined;
        if (p.priority && !priority) return noSuchPriority(p.priority);
        const deliver = p.deliver ? DeliverableValues.find((d) => d === p.deliver) : undefined;
        if (p.deliver && !deliver) return answers.issueCreate.noDeliver;
        let assignee: string | undefined;
        if (p.assignee || p.start === true) {
          const a = yield* choose(p.title + "\n" + (p.description ?? ""), p.assignee ?? "", p.start === true ? c.picked : "");
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
        const item = added.success;
        const noted = answers.issueCreate.noted(item.number, shortTitle(item.title), item.deliver === "answer");
        if (p.start === true) {
          // Written down first: a start that fails leaves the issue in the backlog, and trying again starts it, not a second one.
          const started = yield* Effect.result(issue.start(item.id, channel.id));
          if (started._tag === "Failure") return answers.issueCreate.queuedNoStart(noted, said(started.failure));
          const sent = started.success;
          if (sent.queued) return answers.issueCreate.queuedInChannel(noted, channel.name, sent.queued);
          const h = sent.session ? run.find(sent.session)?.session : undefined;
          const branch = h?.branch ? answers.issueCreate.branchNote(h.branch) : "";
          return answers.issueCreate.dispatched(
            noted,
            channel.name,
            h ? answers.issueCreate.who(h.name, h.id) : answers.issueCreate.noAgentFallback,
            h?.project ?? project,
            branch,
          );
        }
        if (p.draft !== true) return answers.issueCreate.inBacklog(noted, answers.issueCreate.notStartedNote);
        const refined = yield* issue.refine(item.id, [p.title, p.description ?? ""].join("\n").trim(), channel.id).pipe(
          Effect.as(answers.issueCreate.draftingNote),
          Effect.catch((e) => Effect.succeed(answers.issueCreate.draftFailed(said(e)))),
        );
        return answers.issueCreate.inBacklog(noted, refined);
      }),
    );

  const issueUpdate = (who: Who) =>
    tool(
      "issue.update",
      descriptions["issue.update"],
      Effect.fn("Tools.issueUpdate")(function* (p: Orchestrator<"issue.update">) {
        const c = yield* callerOf(who);
        return yield* withIssue(p.id, (item) => {
          const priority = p.priority ? priorityOf(p.priority) : undefined;
          if (p.priority && !priority) return Effect.succeed(noSuchPriority(p.priority));
          let assignee: string | undefined;
          if (p.assignee) {
            const a = agents.named(p.assignee);
            if (!a) return Effect.succeed(answers.noProfileNamed(p.assignee));
            assignee = a.id;
          }
          return issue
            .edit(
              item.id,
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
      "issue.status.update",
      descriptions["issue.status.update"],
      Effect.fn("Tools.issueStatus")(function* (p: Orchestrator<"issue.status.update">) {
        const c = yield* callerOf(who);
        const to = statusOf(p.status);
        if (!to) return noSuchStatus(p.status, ["backlog", "todo", "done", "canceled"]);
        return yield* withIssue(
          p.id,
          Effect.fnUntraced(
            function* (item: Issue) {
              // Sent out with nobody named yet: chosen by the farm's rule, the owner's pick first; another one named hands it over.
              let agent: string | undefined;
              if (p.assignee || (to === "todo" && item.status === "backlog" && !item.assignee)) {
                const chosen = yield* choose(item.title + "\n" + item.description, p.assignee ?? "", p.assignee ? "" : c.picked);
                if (typeof chosen === "string") return answers.issueStatus.notMoved(chosen);
                agent = chosen.id;
              }
              const done = yield* issue.setStatus(item.id, to, p.text ?? "", c.here, c.actor, agent ? { assignee: agent } : {});
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

  const cronCreate = (who: Who) =>
    tool(
      "cron.create",
      descriptions["cron.create"],
      Effect.fn("Tools.cronCreate")(
        function* (p: Orchestrator<"cron.create">) {
          const c = yield* callerOf(who);
          let channel = yield* chat.topOf(c.here);
          if (p.channel) {
            const byName = yield* chat.channelByName(p.channel);
            if (!byName) return yield* refuse(answers.cron.noChannelShort(p.channel));
            channel = byName;
          }
          const w = p.when;
          let when: CronWhen;
          switch (w.kind) {
            case "once": {
              const at = parseTime(w.at ?? "");
              if (at === undefined) return yield* refuse(answers.cron.badTime(w.at ?? ""));
              when = { kind: "once", at };
              break;
            }
            case "every":
              when = { kind: "every", minutes: w.minutes ?? 0 };
              break;
            case "daily":
              when = { kind: "daily", time: w.time ?? "" };
              break;
            case "cron":
              when = { kind: "cron", expr: w.expr ?? "" };
              break;
            case "weekly":
              when = { kind: "weekly", days: (w.days ?? []).map((d) => Math.trunc(d)), time: w.time ?? "" };
          }
          const made = yield* cron.add(
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
          if (made.pending) return answers.cron.pending(cronLine(made, channel.name));
          return answers.cron.confirmed(cronLine(made, channel.name));
        },
        (e) => answered(e),
      ),
    );

  const cronList = tool(
    "cron.list",
    descriptions["cron.list"],
    Effect.fn("Tools.cronList")(function* () {
      const all = cron.list();
      if (all.length === 0) return answers.listCrons.none;
      const names = new Map((yield* chat.channels()).map((c) => [c.id, c.name]));
      return all.map((s) => cronLine(s, names.get(s.channel) ?? "?")).join("\n");
    }),
  );

  const cronDelete = tool("cron.delete", descriptions["cron.delete"], (p: Orchestrator<"cron.delete">) =>
    answered(Effect.map(cron.remove(p.id), (s) => answers.cancelCron.canceled(s.name))),
  );

  const channelCreate = tool(
    "channel.create",
    descriptions["channel.create"],
    Effect.fn("Tools.channelCreate")(function* (p: Orchestrator<"channel.create">) {
      const c = yield* chat.openChannel(p.name, p.description ?? "", p.project ?? "");
      return answers.openChannel.opened(c.name, c.project);
    }),
  );

  const channelUpdate = tool(
    "channel.update",
    descriptions["channel.update"],
    Effect.fn("Tools.channelUpdate")(function* (p: Orchestrator<"channel.update">) {
      const c = (yield* chat.channelByName(p.id)) ?? (yield* chat.channels()).find((x) => x.id === p.id);
      if (!c) return yield* refuse(answers.channelSettings.noChannel(p.id));
      yield* chat.updateChannel(c.id, {
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.project !== undefined ? { project: p.project } : {}),
      });
      return answers.channelSettings.updated(c.name);
    }),
  );

  const graphSplit = (who: Who) =>
    tool(
      "graph.split",
      descriptions["graph.split"],
      Effect.fn("Tools.graphSplit")(function* (p: Orchestrator<"graph.split">) {
        const c = yield* callerOf(who);
        return yield* answered(tasks.split(p.goal, p.project, p.agent ?? "", c.actor));
      }),
    );

  const graphList = tool("graph.list", descriptions["graph.list"], () =>
    Effect.sync(() => {
      const texts = tasks.graphs().filter(isOpen).map(graphText);
      return texts.length > 0 ? texts.join("\n\n") : answers.graphs.none;
    }),
  );

  const graphGet = tool("graph.get", descriptions["graph.get"], (p: Orchestrator<"graph.get">) => answered(Effect.map(tasks.graph(p.id.trim()), graphText)));

  const taskUpdate = (who: Who) =>
    tool(
      "graph.task.update",
      descriptions["graph.task.update"],
      Effect.fn("Tools.taskUpdate")(function* (p: Orchestrator<"graph.task.update">) {
        const by = (yield* callerOf(who)).actor;
        const edit: TaskEdit = {
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.brief !== undefined ? { brief: p.brief } : {}),
          ...(p.needs !== undefined ? { needs: p.needs } : {}),
          ...(p.agent !== undefined ? { agent: p.agent } : {}),
          ...(p.check !== undefined ? { check: p.check } : {}),
        };
        return yield* answered(tasks.editTask(p.id, p.task, edit, by));
      }),
    );

  const taskDelete = (who: Who) =>
    tool(
      "graph.task.delete",
      descriptions["graph.task.delete"],
      Effect.fn("Tools.taskDelete")(function* (p: Orchestrator<"graph.task.delete">) {
        const by = (yield* callerOf(who)).actor;
        return yield* answered(tasks.removeTask(p.id, p.task, by));
      }),
    );

  const graphAct = (who: Who) =>
    tool(
      "graph.act",
      descriptions["graph.act"],
      Effect.fn("Tools.graphAct")(function* (p: Orchestrator<"graph.act">) {
        const c = yield* callerOf(who);
        return yield* answered(tasks.act(p.id, p.action, c.actor));
      }),
    );

  const taskAct = (who: Who) =>
    tool(
      "graph.task.act",
      descriptions["graph.task.act"],
      Effect.fn("Tools.taskAct")(function* (p: Orchestrator<"graph.task.act">) {
        const c = yield* callerOf(who);
        return yield* answered(tasks.taskAct(p.id, p.task, p.action, c.actor));
      }),
    );

  const issueSplit = (who: Who) =>
    sessionSchemaTool(
      "issue.split",
      sessionDescriptions["issue.split"](maxTasks),
      Effect.fn("Tools.issueSplit")(function* (p: Session<"issue.split">) {
        const c = yield* callerOf(who);
        const drafts = p.tasks.map((item) => ({
          id: item.id,
          title: item.title ?? "",
          brief: item.brief,
          ...(item.needs ? { needs: item.needs } : {}),
          agent: item.agent ?? "",
          check: item.check ?? "",
          ...(item.scope ? { scope: item.scope } : {}),
          ...(item.acceptance === true ? { acceptance: true } : {}),
        }));
        return yield* answered(tasks.splitIssue(c.session, p.title ?? "", drafts));
      }),
    );

  // A session's memories are its profile's: "" is every project, none is the one it works in.
  const sessionScope = (c: Caller, project: string | undefined) => (project === undefined ? c.project : project.trim());

  const memorySearch = (who: Who, forOrchestrator: boolean) =>
    forOrchestrator
      ? tool(
          "memory.search",
          descriptions["memory.search"],
          Effect.fn("Tools.memorySearch")(function* (p: Orchestrator<"memory.search">) {
            const agent = (p.agent ?? "").trim() ? yield* profile(p.agent!) : "";
            const q = query({ text: p.text ?? "", project: (p.project ?? "").trim(), ...(agent ? { agent } : {}) });
            return foundText(yield* memory.search(q), q);
          }, answered),
        )
      : sessionSchemaTool(
          "memory.search",
          sessionDescriptions["memory.search"],
          Effect.fn("Tools.memorySearch")(function* (p: Session<"memory.search">) {
            const c = yield* callerOf(who);
            if (!c.agent) return yield* refuse(notWorking);
            const q = query({ agent: c.agent, project: sessionScope(c, p.project), text: p.text ?? "" });
            return foundText(yield* memory.search(q), q);
          }),
        );

  const memoryCreate = (who: Who, forOrchestrator: boolean) =>
    forOrchestrator
      ? tool(
          "memory.create",
          descriptions["memory.create"],
          Effect.fn("Tools.memoryCreate")(function* (p: Orchestrator<"memory.create">) {
            const id = yield* profile(p.agent);
            const c = yield* callerOf(who);
            const m = yield* memory.remember({ agent: id, text: p.text, project: p.project ?? "", by: c.actor });
            return answers.memory.rememberedFor(id, memoryWhere(m), m.id);
          }, answered),
        )
      : sessionSchemaTool(
          "memory.create",
          sessionDescriptions["memory.create"],
          Effect.fn("Tools.memoryCreate")(function* (p: Session<"memory.create">) {
            const c = yield* callerOf(who);
            if (!c.agent) return yield* refuse(notWorking);
            const m = yield* memory.remember({ agent: c.agent, text: p.text, project: sessionScope(c, p.project), by: c.actor });
            return answers.memory.remembered(memoryWhere(m), m.id);
          }),
        );

  // A blocks artifact: a session appends blocks and rewrites a block's text against the rev it read (artifact_content_get),
  // through the same op pipeline the owner's editor uses, written as its profile (its session id when it has none).
  const writer = (c: Caller) => c.agent || c.session;

  const blockCreate = (who: Who) =>
    sessionSchemaTool(
      "artifact.block.create",
      sessionDescriptions["artifact.block.create"],
      Effect.fn("Tools.blockCreate")(function* (p: Session<"artifact.block.create">) {
        const c = yield* callerOf(who);
        const { id, ...block } = p;
        const r = yield* artifacts.appendBlock(id.trim(), writer(c), block);
        if (r.status !== "applied") return yield* refuse(r.reason ?? "");
        return answers.block.appended(r.blockId, r.rev ?? 0);
      }),
    );

  const blockUpdate = (who: Who) =>
    sessionSchemaTool(
      "artifact.block.update",
      sessionDescriptions["artifact.block.update"],
      Effect.fn("Tools.blockUpdate")(function* (p: Session<"artifact.block.update">) {
        const c = yield* callerOf(who);
        const { id, ...block } = p;
        const r = yield* artifacts.updateBlock(id.trim(), writer(c), block);
        if (r.status === "applied") return answers.block.updated(r.blockId, r.rev);
        if (r.status === "conflict") {
          const now = yield* Effect.orElseSucceed(artifacts.blocks(id.trim()), () => undefined);
          const x = now?.blocks.find((b) => b.id === r.blockId);
          return answers.block.notUpdated(r.reason, r.rev, x ? blockLine(x) : "");
        }
        return yield* refuse(r.reason ?? "");
      }),
    );

  return Tools.of({
    orchestrator: (who) => [
      issueList,
      issueGet,
      issueCreate(who),
      issueUpdate(who),
      issueStatus(who),
      issueComment(who),
      issueReview,
      issueDiff(who),
      roster,
      sessionStop(who),
      messageList(who),
      channelList,
      channelCreate,
      channelUpdate,
      projectList,
      cronCreate(who),
      cronList,
      cronDelete,
      graphSplit(who),
      graphList,
      graphGet,
      taskUpdate(who),
      taskDelete(who),
      graphAct(who),
      taskAct(who),
      memorySearch(who, true),
      memoryCreate(who, true),
      artifactList(who),
      artifactGet("orchestrator")(who),
      artifactContent("orchestrator")(who),
      artifactCreate(who),
      artifactVersion("orchestrator")(who),
    ],
    session: (who) => [
      messageSend(who),
      messageList(who),
      unreadList(who),
      sessionList,
      memorySearch(who, false),
      memoryCreate(who, false),
      blockCreate(who),
      blockUpdate(who),
      issueSplit(who),
      sessionArtifactList(who),
      artifactGet("session")(who),
      artifactContent("session")(who),
      sessionArtifactCreate(who),
      artifactVersion("session")(who),
    ],
    start: toolStart,
    sessionLine: (w) => sessionLine(w, clock.currentTimeMillisUnsafe(), numberOf(w)),
  });
});
