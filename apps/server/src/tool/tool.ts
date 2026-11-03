import { Clock, Context, Effect, Layer, Predicate, Schema } from "effect";

import type { Tool as LoopTool } from "@vibevalley/agent/core/loop";
import { maybe, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { Agent } from "@/agent/agent.ts";
import { head } from "@/base/clip.ts";
import { Channel } from "@/channel/channel.ts";
import { Cron } from "@/cron/cron.ts";
import { foundText, Memory, type SearchQuery } from "@/memory/memory.ts";
import { Project } from "@/project/project.ts";
import { resourceWords } from "@/resource/prompts.ts";
import { Resource, ResourceRequest } from "@/resource/resource.ts";
import type { ToolStart } from "@/session/facts.ts";

import { artifactTools } from "./artifact.ts";
import { channelTools } from "./channel.ts";
import {
  answered,
  callerOf,
  customTool,
  refuse,
  sessionSchemaTool,
  tool,
  type Caller,
  type Orchestrator,
  type SessionInput,
  type ToolRefusal,
  type Who,
} from "./definition.ts";
import { issueTools } from "./issue.ts";
import { answers, cronLine, memoryWhere, ownerAgentWord, parseTime, sessionLine } from "./prompts.ts";
import { toolParameters } from "./schemas.ts";

export class Tool extends Context.Service<
  Tool,
  {
    /** The orchestrator's tools, in the order its prompt has always listed them: the order is part of the prompt's prefix. */
    readonly orchestrator: (who: Who) => LoopTool[];
    /** A session's tools, served on /mcp. */
    readonly session: (who: Who) => LoopTool[];
    /** How a tool call reads in the orchestrator's trajectory: its label and the first naming argument. */
    readonly start: (name: string, args: unknown) => ToolStart;
    readonly sessionLine: (session: T.Session) => string;
  }
>()("vibevalley/Tool") {
  static readonly layer = Layer.effect(
    Tool,
    Effect.suspend(() => make),
  );
}

const named = ["id", "agent", "session", "project", "name", "title", "text", "note", "goal"];

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

const resourceTools = Effect.gen(function* () {
  const resource = yield* Resource;
  return (who: Who) =>
    customTool(
      "resource_read",
      resourceWords.description,
      toolParameters(ResourceRequest),
      Schema.decodeUnknownEffect(ResourceRequest),
      Effect.fn("Tool.resourceRead")(function* (input) {
        const caller = yield* callerOf(who);
        return JSON.stringify(yield* resource.read(caller.session || caller.agent, input));
      }),
    );
});

const cronTools = Effect.gen(function* () {
  const chat = yield* Channel;
  const cron = yield* Cron;

  const cronCreate = (who: Who) =>
    tool(
      "cron.create",
      Effect.fn("Tool.cronCreate")(
        function* (p: Orchestrator<"cron.create">) {
          const c = yield* callerOf(who);
          let channel = yield* chat.topOf(c.here);
          if (p.channel) {
            const byName = yield* chat.channelByName(p.channel);
            if (!byName) return yield* refuse(answers.cron.noChannelShort(p.channel));
            channel = byName;
          }
          const w = p.when;
          let when: T.CronWhen;
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
    Effect.fn("Tool.cronList")(function* () {
      const all = cron.list();
      if (all.length === 0) return answers.listCrons.none;
      const names = new Map((yield* chat.channels()).map((c) => [c.id, c.name]));
      return all.map((s) => cronLine(s, names.get(s.channel) ?? "?")).join("\n");
    }),
  );

  const cronDelete = tool("cron.delete", (p: Orchestrator<"cron.delete">) =>
    answered(Effect.map(cron.remove(p.id), (s) => answers.cancelCron.canceled(s.name))),
  );
  return { cronCreate, cronList, cronDelete };
});

const memoryTools = Effect.gen(function* () {
  const agents = yield* Agent;
  const memory = yield* Memory;

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

  // A session's memories are its profile's: "" is every project, none is the one it works in.
  const sessionScope = (c: Caller, project: string | undefined) => (project === undefined ? c.project : project.trim());

  const memorySearch = (who: Who, forOrchestrator: boolean) =>
    forOrchestrator
      ? tool(
          "memory.search",
          Effect.fn("Tool.memorySearch")(function* (p: Orchestrator<"memory.search">) {
            const agent = (p.agent ?? "").trim() ? yield* profile(p.agent!) : "";
            const q = query({ text: p.text ?? "", project: (p.project ?? "").trim(), ...(agent ? { agent } : {}) });
            return foundText(yield* memory.search(q), q);
          }, answered),
        )
      : sessionSchemaTool(
          "memory.search",
          Effect.fn("Tool.memorySearch")(function* (p: SessionInput<"memory.search">) {
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
          Effect.fn("Tool.memoryCreate")(function* (p: Orchestrator<"memory.create">) {
            const id = yield* profile(p.agent);
            const c = yield* callerOf(who);
            const m = yield* memory.remember({ agent: id, text: p.text, project: p.project ?? "", by: c.actor });
            return answers.memory.rememberedFor(id, memoryWhere(m), m.id);
          }, answered),
        )
      : sessionSchemaTool(
          "memory.create",
          Effect.fn("Tool.memoryCreate")(function* (p: SessionInput<"memory.create">) {
            const c = yield* callerOf(who);
            if (!c.agent) return yield* refuse(notWorking);
            const m = yield* memory.remember({ agent: c.agent, text: p.text, project: sessionScope(c, p.project), by: c.actor });
            return answers.memory.remembered(memoryWhere(m), m.id);
          }),
        );
  return { memorySearch, memoryCreate };
});

const make = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const projects = yield* Project;
  const {
    numberOf,
    roster,
    sessionList,
    issueGet,
    issueDiff,
    issueReview,
    issueComment,
    sessionStop,
    issueList,
    issueCreate,
    issueUpdate,
    issueStatus,
    issueReport,
    issueHandback,
    issuePrSubmit,
    issueSplit,
    findIssue,
  } = yield* issueTools;
  const { channelList, messageSend, messageList, unreadList, channelCreate, channelUpdate } = yield* channelTools;
  const {
    artifactList,
    sessionArtifactList,
    artifactGet,
    artifactContent,
    artifactCreate,
    sessionArtifactCreate,
    artifactVersion,
    blockCreate,
    orchestratorBlockCreate,
    blockUpdate,
    orchestratorBlockUpdate,
    blockDelete,
    orchestratorBlockDelete,
  } = yield* artifactTools(findIssue);
  const { memorySearch, memoryCreate } = yield* memoryTools;
  const { cronCreate, cronList, cronDelete } = yield* cronTools;
  const resourceRead = yield* resourceTools;

  const projectList = tool(
    "project.list",
    Effect.fn("Tool.projectList")(function* () {
      const all = yield* projects.list();
      if (all.length === 0) return answers.projects.empty(projects.root);
      return all.map((p) => "- " + p.name + (p.git ? "" : answers.projects.notGitYet)).join("\n");
    }),
  );
  return Tool.of({
    orchestrator: (who) => [
      issueList,
      issueGet,
      issueCreate(who),
      issueUpdate(who),
      issueStatus(who),
      issueComment(who),
      issueReview,
      issueDiff(who),
      resourceRead(who),
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
      memorySearch(who, true),
      memoryCreate(who, true),
      artifactList(who),
      artifactGet("orchestrator")(who),
      artifactContent("orchestrator")(who),
      artifactCreate(who),
      artifactVersion("orchestrator")(who),
      orchestratorBlockCreate(who),
      orchestratorBlockUpdate(who),
      orchestratorBlockDelete(who),
    ],
    session: (who) => [
      messageSend(who),
      resourceRead(who),
      messageList(who),
      unreadList(who),
      sessionList,
      memorySearch(who, false),
      memoryCreate(who, false),
      blockCreate(who),
      blockUpdate(who),
      blockDelete(who),
      issueSplit(who),
      issueReport(who),
      issueHandback(who),
      issuePrSubmit(who),
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
