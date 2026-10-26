// The tools agents call, defined once: the orchestrator gets them in process, a session over /mcp. A
// tool's rule lives in the service that owns it; a tool reads its arguments, says who is calling, and words the answer.
// Every tool answers in a sentence, a refusal included: the model acts on it.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type Agent,
  type Block,
  type BlockAttrs,
  DeliverableValues,
  generalName,
  type GraphAction,
  type Issue,
  IssueStatusValues,
  type Memory,
  orchestratorAgent,
  type RecurrenceWhen,
  type Review,
  type TaskAction,
  type TaskEdit,
} from "@vibevalley/protocol";
import { closedText, phaseText, shortTitle, attentionWantsOwner } from "@vibevalley/protocol/rules";
import { openFindings } from "../issue/state.ts";
import { isOpen, maxTasks } from "../task/graph.ts";
import { head } from "../base/text.ts";
import { graphText } from "../task/rules.ts";
import { inboxLines } from "../channel/rules.ts";
import { Clock, Context, Data, Effect, FiberSet, Layer } from "effect";
import { Agents } from "../agent/agent.ts";
import type { Actor } from "../base/actor.ts";
import { effectTool, type Schema } from "../agent/brain/tool.ts";
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
  changesText,
  channelLine,
  issueDetail,
  issueLine,
  noSuchPriority,
  noSuchStatus,
  parseTime,
  priorityOf,
  recurrenceLine,
  sessionLine,
  statusOf,
  tail,
} from "./words.ts";
import { schemas, sessionSchemas } from "./schemas.ts";

/** Who is calling, at the moment of the call. */
export interface Caller {
  /** The profile: orchestratorAgent for the orchestrator. */
  readonly agent: string;
  /** The session working as agent, and the project it works in; both empty for the orchestrator. */
  readonly session: string;
  readonly project: string;
  /** The conversation the orchestrator is answering. A session's default is its own issue thread, which the channel service knows. */
  readonly here: string;
  /** The profile the owner picked for this input, if any: dispatch prefers it. */
  readonly picked: string;
  /** Who calls, and on whose word: the services judge what it may do by it. */
  readonly actor: Actor;
}

/** Says who is calling; a throw is told to the model as the tool's failure. */
export type Who = () => Caller;

export interface ToolShape {
  /** The orchestrator's tools, in the order its prompt has always listed them: the order is part of the prompt's prefix. */
  readonly orchestrator: (who: Who) => AgentTool[];
  /** A session's tools, served on /mcp. */
  readonly session: (who: Who) => AgentTool[];
  /** How a tool call reads in the orchestrator's trajectory: its label and the first naming argument. */
  readonly start: (name: string, args: unknown) => ToolStart;
  readonly sessionLine: (w: Roster) => string;
}

export class Tools extends Context.Service<Tools, ToolShape>()("vibevalley/Tool") {}

export const labels: Record<string, string> = {
  projects: "项目",
  channels: "频道",
  open_channel: "开频道",
  channel_settings: "改频道",
  recurrence: "定时",
  list_recurrences: "看定时",
  cancel_recurrence: "取消定时",
  accept: "验收",
  changes: "看改动",
  roster: "花名册",
  check: "看进度",
  tell: "带话",
  read_chat: "看对话",
  stop: "叫停",
  dismiss: "收工",
  issues: "找工单",
  issue_create: "记一张工单",
  issue_update: "改工单",
  issue_status: "挪工单",
  graph_split: "拆计划",
  graphs: "看计划",
  task_edit: "改计划",
  graph_action: "计划",
  task_action: "计划的一件",
  issue_split: "拆工单",
  remember: "记一条",
  rewrite_memory: "整理记性",
  search_archive: "翻旧账",
  memory_search: "翻记性",
  memory_add: "替帮工记",
  doc_read: "读文档",
  doc_append: "往文档里加一块",
  doc_update: "改文档的一块",
};

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
  const label = labels[name] ?? name;
  if (about.length > 40) about = head(about, 40) + "…";
  return { text: about ? label + "：" + about : label, action: "other", tool: name, input: args === undefined || args === null ? "{}" : JSON.stringify(args) };
}

const appendTypes = ["paragraph", "heading", "bulleted", "numbered", "todo", "quote", "code"];

const blockLine = (b: Block) => `- 〔${b.id} · 第 ${b.rev} 版 · ${b.type}〕${b.text.map((s) => s.t).join("")}`;

const memoryWhere = (m: Memory) => (m.project ? "项目 " + m.project : "所有项目");

const spaces = /\s+/g;

/** What a tool says when it will not do what it was asked: told to the model as a failed result. */
export class ToolRefusal extends Data.TaggedError("ToolRefusal")<{ readonly message: string }> {}

const refuse = (message: string) => Effect.fail(new ToolRefusal({ message }));

/** A failure as the model reads it. */
const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(reasonOf(e as ApiError)));
const said = (e: unknown) => toError(e).message;

/** Who is calling; who throws for a caller nobody knows, which the model reads as the tool's failure. */
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

  // A tool's work runs on this service's fibers: it ends with the service, and the run's stop interrupts it.
  const runHere = yield* FiberSet.makeRuntimePromise<never>();
  /** An answer, or "没成：" and why. */
  const answered = <E>(e: Effect.Effect<string, E>) => Effect.catch(e, (err) => Effect.succeed("没成：" + said(err)));

  const toolOf =
    (all: Record<string, Schema>) =>
    <P>(name: string, description: string, body: (p: P) => Effect.Effect<string, unknown>) =>
      effectTool<P>({ name, label: labels[name] ?? name, description, parameters: all[name]!, run: (p) => Effect.mapError(body(p), toError) }, runHere);
  const tool = toolOf(schemas);
  const sessionSchemaTool = toolOf(sessionSchemas);

  // The orchestrator may name a session by its id, its name, or words that contain its name.
  const findSession = (key: string) => {
    const all = run.roster();
    return all.find((w) => w.session.id === key) ?? all.find((w) => w.session.name === key) ?? all.find((w) => key.includes(w.session.name));
  };

  // The orchestrator names an issue by its number (#41, 41), its id, or the name or id of a helper working it.
  const findIssue = Effect.fnUntraced(function* (key: string): Effect.fn.Return<Issue | string> {
    const k = key.trim().replace(/^#/, "");
    const all = yield* issue.list();
    if (/^\d+$/.test(k)) return all.find((t) => t.number === Number(k)) ?? "没有 #" + k + " 这张工单：用 issues 找找";
    const byId = all.find((t) => t.id === k);
    if (byId) return byId;
    const w = findSession(k);
    const of = w?.session.issue ? all.find((t) => t.id === w.session.issue) : undefined;
    return of ?? "没有叫 " + k + " 的工单或帮工：用 issues 找找";
  });
  const withIssue = <E>(key: string, f: (t: Issue) => Effect.Effect<string, E>) =>
    Effect.flatMap(findIssue(key), (t) => (typeof t === "string" ? Effect.succeed(t) : f(t)));
  const issueTool = <E>(name: string, description: string, f: (t: Issue) => Effect.Effect<string, E>) =>
    tool(name, description, (p: { issue: string }) => withIssue(p.issue, f));
  /** The helper on the farm working the issue now, if any: its newest session. */
  const workerOf = (t: Issue) => {
    const last = t.sessions.at(-1);
    return last === undefined ? undefined : run.roster().find((w) => w.session.id === last);
  };
  const whoOf = (t: Issue) =>
    workerOf(t)?.session.name ?? (t.assignee === orchestratorAgent ? "管家" : t.assignee ? (agents.agents().find((a) => a.id === t.assignee)?.name ?? "") : "");
  const nobodyOn = (t: Issue) => `#${t.number} 现在没有帮工在做：要它接着做，主人说了以后用 issue_status 挪到待办`;
  const numberOf = (w: Roster) => (w.session.issue ? issue.onBoard().find((t) => t.id === w.session.issue)?.number : undefined);

  // Who reads and speaks in a channel: a session as itself, the orchestrator as the orchestrator.
  const participant = (c: Caller) => c.session || c.agent;

  // Which profile takes a task: the one named (a profile's name or id, or a runtime), else the one the owner picked for
  // this input, else by the farm's rule. A name that matches none is said, not taken for "anyone".
  const choose = Effect.fnUntraced(function* (task: string, name: string, picked: string): Effect.fn.Return<Agent | string> {
    const key = name.trim();
    const a = yield* runtimes.choose(task, key, picked);
    if (!a) return "没有能派的帮工：先去「帮工」页面建一个，或者把 runtime 装好。";
    if (key && a.id !== key && a.name !== key && a.runtime !== key) return "没有叫 " + key + " 的帮工档案或 runtime";
    return a;
  });

  // The orchestrator may say a profile's name or id.
  const profile = (key: string): Effect.Effect<string, ToolRefusal> => {
    const k = key.trim();
    if (k === orchestratorAgent || k === "管家") return refuse("你自己的记性在系统提示里：要记用 remember，要找旧对话用 search_archive");
    const a = agents.named(k);
    return a ? Effect.succeed(a.id) : refuse("没有叫 " + k + " 的帮工档案");
  };
  const notWorking = "你不在场：记性只给在干活的帮工用";

  const query = (q: Partial<SearchQuery>): SearchQuery => ({ agent: "", project: "", text: "", kind: "", limit: 0, ...q });

  const projectsTool = tool(
    "projects",
    "列出工作目录下的项目（每个文件夹是一个项目），以及是不是 git 仓库。",
    Effect.fn("Tools.projects")(function* () {
      const all = yield* projects.list();
      if (all.length === 0) return "工作目录（" + projects.root + "）下还没有项目。";
      return all.map((p) => "- " + p.name + (p.git ? "" : "（还不是 git 仓库，第一次派活时会建）")).join("\n");
    }),
  );

  const channelsTool = tool(
    "channels",
    "列出频道：名字、是做什么的、默认项目。频道是安排活的地方，田头是默认的那个。",
    Effect.fn("Tools.channels")(function* () {
      return (yield* chat.channels()).map((c) => "- " + channelLine(c)).join("\n");
    }),
  );

  const roster = tool("roster", "列出在场的所有帮工：在做什么、上一轮的结果。", () =>
    Effect.sync(() => {
      const all = run.roster();
      return all.length === 0 ? "现在没有在场的帮工。" : all.map((w) => sessionLine(w, clock.currentTimeMillisUnsafe(), numberOf(w))).join("\n");
    }),
  );

  const check = issueTool(
    "check",
    "看一张工单的全部：要做的、验收标准做到哪了、在等主人什么、来龙去脉；有帮工在做时加上它上一轮的完整汇报。",
    Effect.fn("Tools.check")(function* (t: Issue) {
      const w = workerOf(t);
      const timeline = yield* Effect.orElseSucceed(issue.timeline(t.id), () => undefined);
      const lines = [issueDetail(t, whoOf(t), timeline, clock.currentTimeMillisUnsafe())];
      if (w)
        lines.push(
          sessionLine(w, clock.currentTimeMillisUnsafe(), t.number),
          "目录：" + w.place.cwd,
          "上一轮完整汇报（结尾部分）：\n" + (w.lastText ? tail(w.lastText, 2000) : "还没有"),
        );
      return lines.join("\n");
    }),
  );

  const changes = (who: Who) =>
    issueTool(
      "changes",
      "看完成一张工单会合进项目什么：它的提交、改了哪些文件（加减行数）、没提交的改动、会不会冲突。主人问「改了什么」或者完成前想确认时用。",
      Effect.fn("Tools.changes")(
        function* (t: Issue) {
          const c = yield* callerOf(who);
          return changesText(yield* issue.changes(t.id, c.actor));
        },
        Effect.catch((e) => Effect.succeed("看不了改动：" + said(e))),
      ),
    );

  const sessionList = sessionSchemaTool("session_list", "现在谁在场：每个帮工的编号、名字、农机、在哪个项目、在做什么。", () =>
    Effect.sync(() => {
      // Listed without @: an @ wakes someone, and models copy what they read.
      const lines = ["在场的有主人、管家，和这些帮工："];
      for (const h of run.presentSessions())
        lines.push(
          `- ${h.id} ${h.name}（${h.runtime}，在 ${h.project ?? "?"}；${phaseText(h, clock.currentTimeMillisUnsafe())}）工单：${head(h.brief.replace(spaces, " "), 60)}`,
        );
      lines.push("要叫醒谁，就在 channel_say 的话里写 @ 加编号（如 @w3）、@管家、@主人；只是提到，不带 @。");
      return lines.join("\n");
    }),
  );

  const spokenText = (s: Spoken): string => {
    switch (s.kind) {
      case "held": {
        const shown = s.shown ?? [];
        const more = s.more ?? 0;
        return [
          `先没发：${s.target} 里有 ${shown.length + more} 条你还没看过的新消息${more > 0 ? `（这里是最新的 ${shown.length} 条）` : ""}：`,
          inboxLines(shown),
          "",
          "看过了：要改就改了再发；原样发就加 anyway: true；不用发了就不发。",
        ].join("\n");
      }
      case "confirm":
        return `先没发：你刚读的是 ${s.lastRead}，这条却要发到 ${s.target} 顶层。要回在那个串里，就把 target 写成 ${s.lastRead}；确实要发到田头，就加 confirm: true。`;
      default: {
        const absent = s.absent && s.absent.length > 0 ? "。" + s.absent.map((m) => "@" + m).join("、") + " 不在场，没送到" : "";
        return `发出去了：${s.target} msg=${s.message?.number ?? 0}${absent}`;
      }
    }
  };

  const channelSay = (who: Who) =>
    sessionSchemaTool(
      "channel_say",
      "在群聊里发一条消息。target 不填就是你自己的工单串；#<频道> 是一个频道（#" +
        generalName +
        " 是默认的频道田头）；#<频道>:<消息号> 是那条消息下面的串。正文里写 @w3、@管家、@主人 就是叫谁。目标里有你没看过的新消息时会先不发，把新消息给你看。",
      Effect.fn("Tools.channel_say")(function* (p: { text: string; target?: string; anyway?: boolean; confirm?: boolean }) {
        const c = yield* callerOf(who);
        return spokenText(
          yield* chat.speak(participant(c), p.text, {
            ...(p.target ? { target: p.target } : {}),
            ...(p.anyway ? { anyway: true } : {}),
            ...(p.confirm ? { confirm: true } : {}),
          }),
        );
      }),
    );

  const readChat = (who: Who) =>
    tool(
      "read_chat",
      "读一个频道或一个串里说的话。target 写 #<频道>（比如 #田头），或 #<频道>:<消息号>（一个串）；不填就是你正在回话的地方（帮工是自己的工单串）。unread 只读你还没读过的；before 填消息号往前翻。读过的算你看过了。",
      Effect.fn("Tools.read_chat")(function* (p: { target?: string; unread?: boolean; before?: number; limit?: number }) {
        const c = yield* callerOf(who);
        let where = p.target ?? "";
        // A session's default is its own thread, which the channel service fills in.
        if (where === "" && c.session === "") where = "#" + (yield* chat.channelOf(c.here)).name;
        const read = yield* Effect.result(
          chat.read(participant(c), {
            target: where,
            ...(p.unread ? { unread: true } : {}),
            ...(p.before ? { before: Math.trunc(p.before) } : {}),
            ...(p.limit ? { limit: Math.trunc(p.limit) } : {}),
          }),
        );
        if (read._tag === "Failure") return "读不了：" + said(read.failure);
        const r = read.success;
        if (r.messages.length === 0) return p.unread ? r.target + " 里没有你没读的消息" : r.target + " 里还没有话";
        const older = r.older ? `（更早的还有：before:${r.messages[0]!.number} 往前翻）` : "";
        return r.target + older + "：\n" + inboxLines(r.messages);
      }),
    );

  const channelInbox = (who: Who) =>
    sessionSchemaTool(
      "channel_inbox",
      "列出你还没读的对话：在哪、几条、有没有提到你、最后是谁说的。",
      Effect.fn("Tools.channel_inbox")(function* () {
        const c = yield* callerOf(who);
        const rows = yield* chat.inbox(participant(c));
        if (rows.length === 0) return "没有没读的消息。";
        const lines = rows.map((r) => `- ${r.target}：${r.unread} 条` + (r.mentionsYou ? "，提到了你" : "") + (r.latest ? "，最后是 " + r.latest : ""));
        lines.push("下一步：read_chat target=" + rows[0]!.target + " unread=true");
        return lines.join("\n");
      }),
    );

  // Review is judging what came back against what the issue asked for; a pass only makes it ready, completing it stays
  // the owner's (issue_status to done).
  const accept = tool(
    "accept",
    "验收一张交回来的工单：先用 changes 看改动，对着它的验收标准逐条看。过了（pass: true）就能完成；没过就把每条要修的写进 findings，帮工会带着这些接着修一轮。",
    Effect.fn("Tools.accept")(function* (p: { issue: string; pass: boolean; findings?: string[]; text?: string }) {
      return yield* withIssue(p.issue, (t) =>
        issue.review(t.id, { pass: p.pass, ...(p.findings ? { findings: p.findings } : {}), ...(p.text ? { text: p.text } : {}) }).pipe(
          Effect.map((done) => (p.pass ? `#${done.number} 验收过了，等主人点完成` : `#${done.number} 没过验收，${openFindings(done)} 处要修，已经交回给帮工`)),
          Effect.catch((e) => Effect.succeed(said(e))),
        ),
      );
    }),
  );

  const tell = (who: Who) =>
    tool(
      "tell",
      "给在做一张工单的帮工带话：发在工单串里。它正在干就插进去（不能插话的 runtime 会排到这一轮之后），空闲就开新的一轮。",
      Effect.fn("Tools.tell")(function* (p: { issue: string; message: string }) {
        const c = yield* callerOf(who);
        return yield* withIssue(p.issue, (t) => {
          const w = workerOf(t);
          if (!w) return Effect.succeed(nobodyOn(t));
          return chat.tellSession(participant(c), w.session.id, p.message, "").pipe(
            Effect.as(`已经在 #${t.number} 的工单串里跟 ${w.session.name} 说了`),
            Effect.catch((e) => Effect.succeed("没带到：" + said(e))),
          );
        });
      }),
    );

  const stop = (who: Who) =>
    issueTool(
      "stop",
      "叫停在做一张工单的帮工正在做的这一轮。",
      Effect.fn("Tools.stop")(
        function* (t: Issue) {
          const c = yield* callerOf(who);
          yield* issue.act(t.id, { act: "stop" }, "", c.actor);
          return `#${t.number} 这一轮叫停了`;
        },
        Effect.catch((e) => Effect.succeed(said(e))),
      ),
    );
  const dismiss = issueTool(
    "dismiss",
    "让在做一张工单的帮工收工离开，不收它的改动（分支留着）。",
    Effect.fn("Tools.dismiss")(function* (t: Issue) {
      const w = workerOf(t);
      if (!w) return nobodyOn(t);
      yield* run.dismiss(w.session.id);
      return `${w.session.name} 收工了（#${t.number}）`;
    }),
  );

  const issuesTool = tool(
    "issues",
    "找工单、看一批工单：主人问「哪些在等我」（wants_owner）、「某个项目有哪些」「卡住了哪些」、记一件事之前查有没有重复（text），都用它；填 issue 是看一张的全部。每行是编号、短标题、现在怎样、项目、谁在做、等了多久。",
    Effect.fn("Tools.issues")(function* (p: {
      issue?: string;
      status?: string;
      wants_owner?: boolean;
      project?: string;
      text?: string;
      closed?: boolean;
      limit?: number;
    }) {
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
      if (found.length === 0) return p.wants_owner ? "没有在等主人的工单。" : "没有这样的工单。";
      const limit = p.limit && p.limit > 0 ? Math.trunc(p.limit) : 20;
      const more = found.length > limit ? `\n（还有 ${found.length - limit} 张没列）` : "";
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
      "记下一张工单。不填 start 就放进备选、不开工：主人说「记一下」「回头做」「先写下来」「让某某做、先别开始」时这样用。主人要马上做（「去做」「帮我改一下」）才填 start: true，记下就开工，没空位就排队。已经有工单的事不要再建：开工、接着做、换人用 issue_status。记之前先用 issues 的 text 查有没有差不多的，有就问主人是不是同一件。draft 让帮工读过代码把它写成标题、说明、验收标准（花钱），和 start 不一起用。",
      Effect.fn("Tools.issue_create")(function* (p: {
        title: string;
        description?: string;
        project?: string;
        agent?: string;
        priority?: string;
        draft?: boolean;
        start?: boolean;
        channel?: string;
        deliver?: string;
      }) {
        const c = yield* callerOf(who);
        if (p.draft && p.start) return "没记：起草交回来以前开不了工。要马上做就不起草；要起草就先不开工。";
        let channel: Info;
        if (p.channel) {
          const byName = yield* chat.channelByName(p.channel);
          if (!byName) return "没有 " + p.channel + " 这个频道：先用 channels 看看有哪些，或者用 open_channel 开一个。";
          channel = byName;
        } else channel = yield* chat.channelOf(c.here);
        const project = (p.project ?? "").trim() || channel.project;
        if (p.start && !project) return "#" + channel.name + " 没有默认项目：填上 project。";
        const priority = p.priority ? priorityOf(p.priority) : undefined;
        if (p.priority && !priority) return noSuchPriority(p.priority);
        const deliver = p.deliver ? DeliverableValues.find((d) => d === p.deliver) : undefined;
        if (p.deliver && !deliver) return "没记：deliver 是 change（改代码）或 answer（只查、交结论）";
        let assignee: string | undefined;
        if (p.agent || p.start) {
          const a = yield* choose(p.title + "\n" + (p.description ?? ""), p.agent ?? "", p.start ? c.picked : "");
          if (typeof a === "string") return "没记：" + a;
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
        if (added._tag === "Failure") return "没记下：" + said(added.failure);
        const t = added.success;
        const noted = `记下了：#${t.number}「${shortTitle(t.title)}」` + (t.deliver === "answer" ? "（只查、交结论，不改代码）" : "");
        if (p.start) {
          // Written down first: a start that fails leaves the issue in the backlog, and trying again starts it, not a second one.
          const started = yield* Effect.result(issue.start(t.id, channel.id));
          if (started._tag === "Failure") return `${noted}，在备选里；没开工：${said(started.failure)}。要再开工用 issue_status 挪到待办，不要再建一张`;
          const sent = started.success;
          if (sent.queued) return `${noted}，在 #${channel.name} 排进待办：${sent.queued}`;
          const h = sent.session ? run.find(sent.session)?.session : undefined;
          const branch = h?.branch ? "，分支 " + h.branch : "";
          return `${noted}，已在 #${channel.name} 派 ${h ? h.name + "（" + h.id + "）" : "帮工"}去 ${h?.project ?? project}${branch}`;
        }
        if (!p.draft) return `${noted}，在备选里，没开工`;
        const refined = yield* issue.refine(t.id, [p.title, p.description ?? ""].join("\n").trim(), channel.id).pipe(
          Effect.as("，帮工在起草"),
          Effect.catch((e) => Effect.succeed("；起草没开始：" + said(e))),
        );
        return `${noted}，在备选里${refined}`;
      }),
    );

  const issueUpdate = (who: Who) =>
    tool(
      "issue_update",
      "改一张工单：优先级、验收方式随时能改；标题、说明、项目、谁来做、验收标准只在派出去以前能改。只在主人叫你改时用：你自己看出来该改的，先在频道里问主人。",
      Effect.fn("Tools.issue_update")(function* (p: {
        issue: string;
        title?: string;
        description?: string;
        project?: string;
        agent?: string;
        priority?: string;
        acceptance?: string;
        criteria?: string[];
      }) {
        const c = yield* callerOf(who);
        return yield* withIssue(p.issue, (t) => {
          const priority = p.priority ? priorityOf(p.priority) : undefined;
          if (p.priority && !priority) return Effect.succeed(noSuchPriority(p.priority));
          if (p.acceptance && p.acceptance !== "glance" && p.acceptance !== "required") return Effect.succeed("验收方式只有 glance 和 required");
          let assignee: string | undefined;
          if (p.agent) {
            const a = agents.named(p.agent);
            if (!a) return Effect.succeed("没有叫 " + p.agent + " 的帮工档案");
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
                ...(p.acceptance ? { review: p.acceptance as Review } : {}),
                ...(p.criteria !== undefined ? { criteria: p.criteria } : {}),
              },
              c.actor,
            )
            .pipe(
              Effect.map((done) => "改好了：" + issueLine(done, whoOf(done), clock.currentTimeMillisUnsafe()).slice(2)),
              Effect.catch((e) => Effect.succeed("没改：" + said(e))),
            );
        });
      }),
    );

  const issueStatus = (who: Who) =>
    tool(
      "issue_status",
      "挪一张工单的状态，和主人在看板上拖卡片一样：备选挪到待办就是开工（没空位就排队）；排着队的挪回备选是先别开工；等你看挪回待办是带一句话再干一轮；已完成、已取消挪回待办是带一句话重开；挪到待办时 agent 填另一个帮工就是换人接手（在干的要先 stop）；等你看挪到已完成是完成：照工单交付，有提交就合进主分支或开 PR，没有改动不碰 git，keep_branch 是完成但分支留着不合；挪到已取消是不做了、帮工回家、改动不收。只在主人叫你挪时用；挪不了时照回答里的原因跟主人说。",
      Effect.fn("Tools.issue_status")(function* (p: { issue: string; to: string; text?: string; agent?: string; keep_branch?: boolean }) {
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
                if (typeof chosen === "string") return "没挪：" + chosen;
                agent = chosen.id;
              }
              const done = yield* issue.setStatus(t.id, to, p.text ?? "", c.here, c.actor, {
                ...(agent ? { agent } : {}),
                ...(p.keep_branch ? { keepBranch: true } : {}),
              });
              // Completing says what it delivered, which follows the issue: merged, no change, its branch kept, or a PR still open.
              if (to === "done" && done.status === "done") return `#${done.number} ${closedText(done)}`;
              if (to === "done" && done.pullRequest?.state === "open") return `#${done.number} 的 PR 开着：${done.pullRequest.url}，合了才算完成`;
              return "挪好了：" + issueLine(done, whoOf(done), clock.currentTimeMillisUnsafe()).slice(2);
            },
            Effect.catch((e) => Effect.succeed("没挪：" + said(e))),
          ),
        );
      }),
    );

  const recurrenceTool = (who: Who) =>
    tool(
      "recurrence",
      "定一件按时间来的事：到点时频道里出现一条「⏰ 定时」消息，然后你收到它照着做；填了 agent 就直接派那个帮工去做（工单就是 text），不经过你。kind：once（at 填 ISO 时间，带时区，比如 2026-10-13T09:00:00+08:00）、every（minutes 每隔几分钟，至少 1）、daily（time 填 HH:MM）、weekly（days 填周几，0 是周日，加 time）、cron（cron 填五段：分 时 日 月 周几，比如工作日 9 点是 0 9 * * 1-5，每月 1 号 10 点是 0 10 1 * *；前四种说不清的才用它）。text 写清楚到时候做什么、做完告诉谁。",
      Effect.fn("Tools.recurrence")(
        function* (p: {
          name: string;
          text: string;
          kind: string;
          at?: string;
          minutes?: number;
          time?: string;
          days?: number[];
          cron?: string;
          channel?: string;
          agent?: string;
          project?: string;
          tz?: string;
        }) {
          const c = yield* callerOf(who);
          let channel = yield* chat.channelOf(c.here);
          if (p.channel) {
            const byName = yield* chat.channelByName(p.channel);
            if (!byName) return yield* refuse("没有 " + p.channel + " 这个频道：先用 channels 看看");
            channel = byName;
          }
          let when: RecurrenceWhen;
          switch (p.kind) {
            case "once": {
              const at = parseTime(p.at ?? "");
              if (at === undefined) return yield* refuse("at 不是一个时间：" + (p.at || "（没填）"));
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
          if (made.pending)
            return (
              "定好了，等主人同意才生效：\n" +
              recurrenceLine(made, channel.name) +
              "\n这一轮不是主人叫你定的，而它会反复来或直接派帮工：主人在定时列表里点「同意」才开始。跟主人说一声它是做什么的。"
            );
          return "定好了：\n" + recurrenceLine(made, channel.name);
        },
        (e) => answered(e),
      ),
    );

  const listRecurrences = tool(
    "list_recurrences",
    "列出定时：编号、在哪个频道、什么时候、下次什么时候、到点做什么。",
    Effect.fn("Tools.list_recurrences")(function* () {
      const all = recurrence.list();
      if (all.length === 0) return "没有定时。";
      const names = new Map((yield* chat.channels()).map((c) => [c.id, c.name]));
      return all.map((s) => recurrenceLine(s, names.get(s.channel) ?? "?")).join("\n");
    }),
  );

  const cancelRecurrence = tool("cancel_recurrence", "删掉一个定时（编号从 list_recurrences 看）。", (p: { id: string }) =>
    answered(Effect.map(recurrence.remove(p.id), (s) => "删掉了「" + s.name + "」。")),
  );

  const openChannel = tool(
    "open_channel",
    "开一个新频道：一件长期的事、一个项目，单独一个地方说话、派活。name 是频道名（字母、数字、汉字、- 和 _），description 写它是做什么的，project 是它的默认项目（在这里派的活默认在这个项目里干）。主人要求了才开。",
    Effect.fn("Tools.open_channel")(function* (p: { name: string; description?: string; project?: string }) {
      const c = yield* chat.openChannel(p.name, p.description ?? "", p.project ?? "");
      return "开好了 #" + c.name + (c.project ? "，默认项目 " + c.project : "") + "。";
    }),
  );

  const channelSettings = tool(
    "channel_settings",
    "改一个频道是做什么的（description），或它的默认项目（project，写空字符串就是不要默认项目）。",
    Effect.fn("Tools.channel_settings")(function* (p: { channel: string; description?: string; project?: string }) {
      const c = yield* chat.channelByName(p.channel);
      if (!c) return yield* refuse("没有 " + p.channel + " 这个频道");
      yield* chat.updateChannel(c.id, p.description, p.project);
      return "改好了 #" + c.name + "。";
    }),
  );

  const graphSplit = (who: Who) =>
    tool(
      "graph_split",
      "起一个计划：派一个帮工读代码，把一件很长的活拆成几件，有先后（每件一个帮工），拆好了等主人看过再开工。goal 是主人要做的事，照他的原话写全；project 是项目文件夹名。",
      Effect.fn("Tools.graph_split")(function* (p: { goal: string; project: string; agent?: string }) {
        const c = yield* callerOf(who);
        return yield* answered(tasks.split(p.goal, p.project, p.agent ?? "", c.actor));
      }),
    );

  const graphsTool = tool("graphs", "列出计划：每件的状态、谁在做、结论。", (p: { id?: string }) =>
    Effect.sync(() => {
      const texts = tasks
        .graphs()
        .filter((g) => (p.id ? g.id === p.id : isOpen(g)))
        .map(graphText);
      if (texts.length > 0) return texts.join("\n\n");
      return p.id ? "没有 " + p.id + " 这个计划" : "现在没有计划。";
    }),
  );

  const taskEdit = (who: Who) =>
    tool(
      "task_edit",
      "改计划里的一件：工单、标题、要等的、谁来做、做完跑的检查命令；没有这一件就加上。remove 为 true 时删掉它。没开工的计划什么都能改；开工以后只能改还没开始或没做成的。",
      Effect.fn("Tools.task_edit")(function* (p: {
        graph: string;
        task: string;
        title?: string;
        brief?: string;
        needs?: string[];
        agent?: string;
        check?: string;
        remove?: boolean;
      }) {
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
      "对整个计划：start 开工（主人看过、同意了才用），pause 暂停（正在做的做完，不开新的），resume 继续，abandon 放弃（分支留着），merge 合进主分支（都做完以后，把计划的分支合进主分支）。",
      Effect.fn("Tools.graph_action")(function* (p: { graph: string; action: GraphAction }) {
        const c = yield* callerOf(who);
        return yield* answered(tasks.act(p.graph, p.action, c.actor));
      }),
    );

  const taskAction = (who: Who) =>
    tool(
      "task_action",
      "对计划里的一件：retry 重试没做成的，skip 跳过它（后面的照常开工）。",
      Effect.fn("Tools.task_action")(function* (p: { graph: string; task: string; action: TaskAction }) {
        const c = yield* callerOf(who);
        return yield* answered(tasks.taskAct(p.graph, p.task, p.action, c.actor));
      }),
    );

  const issueSplit = (who: Who) =>
    sessionSchemaTool(
      "issue_split",
      `把你手上这张工单拆成几张子工单，挂在它下面，马上派给几个帮工分头做（有先后的按 needs 等）。读完代码觉得这件活一个人做太大、能分成几件各自提交和验证的事时用；一般三到六张，最多 ${maxTasks} 张。拆之前把已经做的提交：计划的分支从你的分支顶上开，没提交的带不过去。拆完你就别再改代码，汇报拆成了哪几步，这一轮结束。`,
      Effect.fn("Tools.issue_split")(function* (p: {
        title?: string;
        tasks: { id: string; title?: string; brief: string; needs?: string[]; agent?: string; check?: string; scope?: string[]; acceptance?: boolean }[];
      }) {
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
          "在帮工档案的记性里找：它们记下的话、主人替它们记的、做过的活。agent 不填就找所有档案；project 只找那个项目的和所有项目都用的。派活前想知道某个项目有什么约定、谁做过类似的活时用。",
          Effect.fn("Tools.memory_search")(function* (p: { query?: string; agent?: string; project?: string }) {
            const agent = (p.agent ?? "").trim() ? yield* profile(p.agent!) : "";
            const q = query({ text: p.query ?? "", project: (p.project ?? "").trim(), ...(agent ? { agent } : {}) });
            return foundText(yield* memory.search(q), q);
          }, answered),
        )
      : sessionSchemaTool(
          "memory_search",
          "在你的记性里找：你和主人以前替你的档案记下的话、做过的活。只找这个项目的和所有项目都用的；all_projects 也找别的项目的。干到一半想知道「这个项目的测试怎么跑」「上次这个坑怎么绕过去的」时用。",
          Effect.fn("Tools.memory_search")(function* (p: { query?: string; all_projects?: boolean }) {
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
          "替一个帮工档案记一句，它以后派出去的帮工开工时会想起。主人要某个帮工以后都记得一件事时用；不填 project 就是所有项目都用。主人对你自己说的偏好用 remember。",
          Effect.fn("Tools.memory_add")(function* (p: { agent: string; text: string; project?: string }) {
            const id = yield* profile(p.agent);
            const c = yield* callerOf(who);
            const m = yield* memory.remember({ agent: id, text: p.text, project: p.project ?? "", by: c.actor });
            return "替 " + id + " 记下了（" + memoryWhere(m) + "）〔" + m.id + "〕";
          }, answered),
        )
      : sessionSchemaTool(
          "memory_add",
          "往你的记性里记一句，你的档案以后派出去的帮工开工时会想起。记这个项目的；all_projects 记成所有项目都用的。只记以后还用得上的：约定、坑、命令，不记这一次的进度。",
          Effect.fn("Tools.memory_add")(function* (p: { text: string; all_projects?: boolean; agent?: string }) {
            const c = yield* callerOf(who);
            if (!c.agent) return yield* refuse(notWorking);
            if (p.agent && p.agent !== c.agent) return yield* refuse("只能记进你自己的档案（" + c.agent + "），" + p.agent + " 的记性不归你写");
            const m = yield* memory.remember({ agent: c.agent, text: p.text, project: p.all_projects ? "" : c.project, by: c.actor });
            return "记下了（" + memoryWhere(m) + "）〔" + m.id + "〕";
          }),
        );

  // Documents: a session reads one, appends blocks and rewrites a block's text against the rev it read, through the same
  // op pipeline the owner's editor uses, written as its profile (its session id when it has none).
  const writer = (c: Caller) => c.agent || c.session;

  const docRead = (who: Who) =>
    sessionSchemaTool(
      "doc_read",
      "读一篇文档：每一块的 id、第几版、类型和字。改一块之前先读，doc_update 要用这里的 id 和版本。",
      Effect.fn("Tools.doc_read")(function* (p: { doc: string }) {
        yield* callerOf(who);
        const snap = yield* docs.get(p.doc.trim());
        return ["《" + snap.doc.title + "》，" + snap.blocks.length + " 块：", ...snap.blocks.map(blockLine)].join("\n");
      }),
    );

  const docAppend = (who: Who) =>
    sessionSchemaTool(
      "doc_append",
      "在文档末尾加一块。写长的东西时一段一块，不要把整篇塞进一块；写一块要接着改，就用回答里的 id 和版本调 doc_update。",
      Effect.fn("Tools.doc_append")(function* (p: { doc: string; text: string; type?: string; level?: number }) {
        const c = yield* callerOf(who);
        const type = (p.type ?? "").trim() || "paragraph";
        if (!appendTypes.includes(type)) return yield* refuse("块的类型只能是 " + appendTypes.join("、"));
        const attrs: BlockAttrs =
          type === "heading" ? { level: p.level && p.level >= 1 && p.level <= 3 ? Math.trunc(p.level) : 2 } : type === "todo" ? { checked: false } : {};
        const [b, r] = yield* docs.append(p.doc.trim(), writer(c), type, attrs, p.text);
        if (!r || r.status !== "applied" || !b) return yield* refuse(r?.reason ?? "");
        return `加了一块〔${b.id}〕，第 ${b.rev} 版。接着改它用 doc_update，block 填 ${b.id}，base_rev 填 ${b.rev}。`;
      }),
    );

  const docUpdate = (who: Who) =>
    sessionSchemaTool(
      "doc_update",
      "把一块的字整段换成新的。base_rev 是你读到或写下它时的版本：这之后别人改过它的字，就不改，回答里有现在的字和版本，看过再决定要不要照着重写。",
      Effect.fn("Tools.doc_update")(function* (p: { doc: string; block: string; base_rev: number; text: string }) {
        const c = yield* callerOf(who);
        const [, r] = yield* docs.updateText(p.doc.trim(), writer(c), p.block.trim(), Math.trunc(p.base_rev ?? 0), p.text);
        if (r?.status === "applied") return `改好了〔${r.blockId}〕，现在是第 ${r.rev} 版。`;
        if (r?.status === "conflict") {
          const now = yield* Effect.orElseSucceed(docs.get(p.doc.trim()), () => undefined);
          const x = now?.blocks.find((b) => b.id === r.blockId);
          return `没改：${r.reason}，现在是第 ${r.rev} 版。${x ? "\n现在的字：" + blockLine(x) : ""}`;
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
