import { Clock, Context, Effect, Layer, Predicate } from "effect";

import type { Tool as LoopTool } from "@vibevalley/agent/core/loop";
import { maybe, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { head } from "#/base/clip.ts";
import type { ToolStart } from "#/session/reaction.ts";

import { artifactTools } from "./artifact.ts";
import { channelTools } from "./channel.ts";
import { cronTools } from "./cron.ts";
import { issueTools } from "./issue.ts";
import { memoryTools } from "./memory.ts";
import { pkmTools } from "./pkm.ts";
import { sessionLine } from "./prompts.ts";
import { repoTools } from "./repo.ts";
import { resourceTools } from "./resource.ts";
import type { Who } from "./schemas.ts";

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

const named = ["id", "agent", "session", "repo", "name", "title", "text", "note", "goal"];

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
  const notes = yield* pkmTools;
  const { cronCreate, cronList, cronDelete } = yield* cronTools;
  const resourceRead = yield* resourceTools;
  const repoList = yield* repoTools;

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
      repoList,
      cronCreate(who),
      cronList,
      cronDelete,
      memorySearch(who, true),
      memoryCreate(who, true),
      ...notes.orchestrator(who),
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
      ...notes.session(who),
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
