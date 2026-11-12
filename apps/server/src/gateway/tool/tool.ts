import type { Tool as LoopTool } from "@vibevalley/agent/core/tool";
import { maybe, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import type { Who } from "#/base/actor.ts";
import { head } from "#/base/clip.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Artifact } from "#/modules/artifact/artifact.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Issue } from "#/modules/issue/issue.ts";
import type { Media } from "#/modules/media/media.ts";
import type { Memory } from "#/modules/memory/memory.ts";
import type { Pkm } from "#/modules/pkm/pkm.ts";
import type { Repo } from "#/modules/repo/repo.ts";
import type { ToolStart } from "#/modules/session/reaction.ts";
import type { Session } from "#/modules/session/session.ts";

import { artifactTools } from "./artifact.ts";
import { channelTools } from "./channel.ts";
import { cronTools } from "./cron.ts";
import { issueTools } from "./issue.ts";
import { libraryTools } from "./library.ts";
import { mediaTools } from "./media.ts";
import { memoryTools } from "./memory.ts";
import { pkmTools } from "./pkm.ts";
import { sessionLine } from "./prompts.ts";
import { repoTools } from "./repo.ts";
import { makeResourceReader, type ReadResource, type ResourcePage, resourceTools } from "./resource.ts";

export interface Tool {
  /** The orchestrator's tools, in the order its prompt has always listed them: the order is part of the prompt's prefix. */
  readonly orchestrator: (who: Who) => LoopTool[];
  /** A session's tools, served on /mcp. */
  readonly session: (who: Who) => LoopTool[];
  /** Authorized, paged reads over stable per-session snapshots (`vv://...`). Throws ResourceError, ApiError or RepoError. */
  readonly readResource: (session: string, input: ReadResource) => Promise<ResourcePage>;
  /** How a tool call reads in the orchestrator's trajectory: its label and the first naming argument. */
  readonly start: (name: string, args: unknown) => ToolStart;
  readonly sessionLine: (session: T.Session) => string;
}

export interface ToolDeps {
  readonly clock: Time;
  readonly log: Logger;
  readonly agent: Agent;
  readonly session: Session;
  readonly issue: Issue;
  readonly channel: Channel;
  readonly memory: Memory;
  readonly pkm: Pkm;
  readonly media: Media;
  readonly artifact: Artifact;
  readonly repo: Repo;
}

const named = ["id", "agent", "session", "repo", "name", "title", "text", "note", "goal"];

export function toolStart(name: string, args: unknown): ToolStart {
  let about = "";
  for (const k of named) {
    const v: unknown = typeof args === "object" && args !== null && k in args ? Reflect.get(args, k) : undefined;
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

export async function makeTool(deps: ToolDeps): Promise<Tool> {
  const { clock } = deps;
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
  } = issueTools(deps);
  const { channelList, messageSend, messageList, unreadList, channelCreate, channelUpdate } = channelTools(deps);
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
  } = artifactTools(deps, findIssue);
  const { memorySearch, memoryCreate } = memoryTools(deps);
  const notes = pkmTools(deps);
  const media = mediaTools(deps);
  const library = libraryTools(deps);
  const { cronCreate, cronList, cronDelete } = cronTools(deps);
  const readResource = makeResourceReader(deps);
  const resourceRead = resourceTools(readResource);
  const repoList = repoTools(deps);

  return {
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
      ...media(who),
      ...library.orchestrator(who),
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
      ...library.session(who),
    ],
    readResource,
    start: toolStart,
    sessionLine: (w) => sessionLine(w, clock.now(), numberOf(w)),
  };
}
