import { t } from "@vibevalley/i18n";

import type { Session } from "@vibevalley/protocol";
import { isBusy, roomLeft } from "@vibevalley/protocol/rules";

import { runtimeLabel } from "@/agent/seed.ts";

export interface SessionLimits {
  readonly workspace: number;
  readonly perRuntime: number;
  readonly perProject: number;
}

/** Why one more cannot start; except is a session about to work again, which does not count against itself. */
export function noRoom(sessions: readonly Session[], runtime: string, project: string, limits: SessionLimits, except = ""): string {
  const room = roomLeft(sessions, project, limits.workspace, limits.perProject, except);
  if (room.farm === 0) return t("server.session.noRoom.farm", { max: limits.workspace });
  const onRuntime = sessions.filter((h) => isBusy(h) && h.id !== except && h.runtime === runtime).length;
  if (limits.perRuntime > 0 && onRuntime >= limits.perRuntime)
    return t("server.session.noRoom.runtime", { runtime: runtimeLabel(runtime), on: onRuntime, max: limits.perRuntime });
  if (room.project === 0) return t("server.session.noRoom.project", { project, on: room.inProject, max: limits.perProject });
  return "";
}

export function sessionName(sessions: readonly Session[], agentId: string, agentName: string): string {
  const same = sessions.filter((h) => h.agent === agentId).length;
  return same === 0 ? agentName : `${agentName} ${same + 1}`;
}

/** Who goes home so one more can come, when the farm holds max: whoever has been idle longest; none while there is room,
 * or when every one is at work. */
export function whoMakesRoom(sessions: readonly Session[], max: number): Session | undefined {
  if (sessions.length < max) return undefined;
  // Idle since its last run ended, or since it came when it has not run.
  const idleSince = (s: Session) => s.lastRun?.at ?? s.hiredAt;
  return sessions.filter((s) => !isBusy(s)).toSorted((a, b) => idleSince(a) - idleSince(b))[0];
}
