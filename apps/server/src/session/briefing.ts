import type { McpServer } from "@botiverse/oar";

import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { isBusy, roomLeft } from "@vibevalley/protocol/rules";

import type { MergeFailure } from "@/project/shapes.ts";
import { runtimeLabel } from "@/runtime/presets.ts";

import { recallHead, recallIntro } from "./prompts.ts";

/** What the detail panel shows starts after it. */
export const briefBreak = "\n\n---\n\n";

/** Set apart, so the detail panel shows the two apart. */
export const withRecall = (block: string, input: string) => (block ? block + briefBreak + input : input);

/** recalledIn finds the block by these words. */
export const recallBlock = (recalled: readonly string[]) => (recalled.length === 0 ? "" : [recallHead + recallIntro, ...recalled].join("\n"));

export function recalledIn(input: string): string {
  const parts = input.split(briefBreak);
  if (parts.length < 2) return "";
  const block = parts[parts.length - 2]!;
  return block.startsWith(recallHead) ? block.split("\n").slice(1).join("\n") : "";
}

export function instructions(agent: T.Agent, library: readonly T.Skill[]): string {
  const parts = [agent.persona.trim()];
  for (const id of agent.skills) {
    const skill = library.find((s) => s.id === id);
    if (skill) parts.push("## " + skill.name + "\n" + skill.body.trim());
  }
  return parts.filter((p) => p !== "").join("\n\n");
}

export const toOarMcp = (server: T.MCPServer): McpServer =>
  server.type === "http"
    ? { name: server.name, type: "http", url: server.url, headers: server.headers }
    : { name: server.name, command: server.command, args: server.args, env: server.env };

export const conflictBrief = (base: string, files: readonly string[]) => t("server.session.conflictBrief", { base, files: list(files) });

/** Who settles a conflict when the work does not go in: the owner (an issue: told what to tell the helper), or the helper
 * at once (a task graph's step). */
export type Settle = "owner" | "helper";

export interface SessionLimits {
  readonly workspace: number;
  readonly perRuntime: number;
  readonly perProject: number;
}

/** Why one more cannot start; except is a session about to work again, which does not count against itself. */
export function noRoom(
  sessions: readonly Pick<T.Session, "id" | "runtime" | "project" | "phase">[],
  runtime: string,
  project: string,
  limits: SessionLimits,
  except = "",
  byOwnerComment = false,
): string {
  const room = roomLeft(sessions, project, limits.workspace + (byOwnerComment ? 1 : 0), limits.perProject, except);
  if (room.farm === 0) return t("server.session.noRoom.farm", { max: limits.workspace });
  const onRuntime = sessions.filter((h) => isBusy(h) && h.id !== except && h.runtime === runtime).length;
  if (limits.perRuntime > 0 && onRuntime >= limits.perRuntime)
    return t("server.session.noRoom.runtime", { runtime: runtimeLabel(runtime), on: onRuntime, max: limits.perRuntime });
  if (room.project === 0) return t("server.session.noRoom.project", { project, on: room.inProject, max: limits.perProject });
  return "";
}

export function sessionName(sessions: readonly Pick<T.Session, "agent">[], agentId: string, agentName: string): string {
  const same = sessions.filter((h) => h.agent === agentId).length;
  return same === 0 ? agentName : `${agentName} ${same + 1}`;
}

/** Who goes home so one more can come, when the farm holds max: whoever has been idle longest; none while there is room,
 * or when every one is at work. */
export function whoMakesRoom(sessions: readonly T.Session[], max: number): T.Session | undefined {
  if (sessions.length < max) return undefined;
  // Idle since its last run ended, or since it came when it has not run.
  const idleSince = (s: T.Session) => s.lastRun?.at ?? s.hiredAt;
  return sessions.filter((s) => !isBusy(s)).toSorted((a, b) => idleSince(a) - idleSince(b))[0];
}

/** What a take-in that did not go through means. The session stays with its branch and worktree either way. fix: what
 * the helper is sent back with ("" when it is left to the owner); owner: what the owner is told; notice: the farm's line;
 * short: the line a task graph keeps. */
export function notTakenIn(
  f: MergeFailure,
  name: string,
  settle: Settle,
): { readonly fix: string; readonly owner: string; readonly notice: string; readonly short: string } {
  switch (f.kind) {
    case "conflict": {
      const files = list(f.files);
      return {
        fix: settle === "helper" ? conflictBrief(f.base, f.files) : "",
        owner: t("server.session.notTaken.conflictOwner", { base: f.base, files, name, brief: conflictBrief(f.base, f.files) }),
        notice: t("server.session.notTaken.conflictNotice", { name, base: f.base, files }),
        short: t("server.session.notTaken.conflictShort", { base: f.base, files }),
      };
    }
    case "check":
      return {
        fix: t("server.session.notTaken.checkFix", { reason: f.reasonText }),
        owner: t("server.session.notTaken.owner", { why: f.reasonText, name }),
        notice: t("server.session.notTaken.notice", { name, why: f.reasonText }),
        short: t("server.session.notTaken.checkShort"),
      };
    case "error": {
      const why = f.reasonText || f.message;
      return { fix: "", owner: t("server.session.notTaken.owner", { why, name }), notice: t("server.session.notTaken.notice", { name, why }), short: why };
    }
  }
}
