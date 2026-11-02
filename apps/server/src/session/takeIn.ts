import type { McpServer } from "@botiverse/oar";

import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import type { MergeFailure } from "@/project/shapes.ts";

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
