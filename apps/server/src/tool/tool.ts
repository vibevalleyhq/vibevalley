import { Clock, Context, Effect, Layer, Predicate } from "effect";

import type { Tool as LoopTool } from "@vibevalley/agent/core/loop";
import { maybe, t } from "@vibevalley/i18n";

import { head } from "@/base/clip.ts";
import { Project } from "@/project/project.ts";
import type { ToolStart } from "@/session/facts.ts";
import { type Roster } from "@/session/session.ts";

import { artifactTools } from "./artifact.ts";
import { channelTools } from "./channel.ts";
import { cronTools } from "./cron.ts";
import { type Who, tool } from "./definition.ts";
import { graphTools } from "./graph.ts";
import { issueTools } from "./issue.ts";
import { memoryTools } from "./memory.ts";
import { answers, sessionLine } from "./prompts.ts";

export class Tool extends Context.Service<
  Tool,
  {
    /** The orchestrator's tools, in the order its prompt has always listed them: the order is part of the prompt's prefix. */
    readonly orchestrator: (who: Who) => LoopTool[];
    /** A session's tools, served on /mcp. */
    readonly session: (who: Who) => LoopTool[];
    /** How a tool call reads in the orchestrator's trajectory: its label and the first naming argument. */
    readonly start: (name: string, args: unknown) => ToolStart;
    readonly sessionLine: (w: Roster) => string;
  }
>()("vibevalley/Tool") {
  static readonly layer = Layer.effect(
    Tool,
    Effect.suspend(() => make),
  );
}

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
    findIssue,
  } = yield* issueTools;
  const { channelList, messageSend, messageList, unreadList, channelCreate, channelUpdate } = yield* channelTools;
  const { artifactList, sessionArtifactList, artifactGet, artifactContent, artifactCreate, sessionArtifactCreate, artifactVersion, blockCreate, blockUpdate } =
    yield* artifactTools(findIssue);
  const { graphSplit, graphList, graphGet, taskUpdate, taskDelete, graphAct, taskAct, issueSplit } = yield* graphTools;
  const { memorySearch, memoryCreate } = yield* memoryTools;
  const { cronCreate, cronList, cronDelete } = yield* cronTools;

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
