// Where each session stands and what it has been doing, for the farm to draw:
// no business rule reads a session's play.

import { type WorkspaceState, type FactDoing, type FactStation, maxRunning, type Session, type SessionAction, type SessionPlay } from "@vibevalley/protocol";
import { farmOf } from "@vibevalley/protocol/rules";

import { sessionOf, withSession } from "@/session/roster.ts";

export const historyLimit = 30;

export const fileLimit = 24;

export const commandLimit = 12;

/** One saved before plays were kept has an empty one, with no bed. */
export const playOf = (h: Session): SessionPlay => h.play ?? { station: -1, history: [], toolsThisRun: 0, counts: {}, files: [], commands: [] };

/** A free bed on `project`'s farm: `prefer` when it is free there, else the first free one, else -1. */
export function freeStation(sessions: readonly Session[], project: string, prefer?: number): number {
  const taken = new Set(sessions.filter((h) => farmOf(h) === project).map((h) => playOf(h).station));
  if (prefer !== undefined && prefer >= 0 && prefer < maxRunning && !taken.has(prefer)) return prefer;
  for (let i = 0; i < maxRunning; i++) if (!taken.has(i)) return i;
  return -1;
}

/** Every session on a bed of its own farm: one without a bed, or on a bed another of its farm holds, moves to a free one. */
export function withStations(state: WorkspaceState): WorkspaceState {
  const placed: Session[] = [];
  let moved = false;
  for (const h of state.sessions) {
    const at = playOf(h).station;
    const clash = placed.some((x) => farmOf(x) === farmOf(h) && playOf(x).station === at);
    if (at >= 0 && !clash) {
      placed.push(h);
      continue;
    }
    moved = true;
    placed.push({ ...h, play: { ...playOf(h), station: freeStation(placed, farmOf(h)) } });
  }
  return moved ? { ...state, sessions: placed } : state;
}

const remember = (list: readonly string[], item: string, limit: number) => {
  const out = list.filter((x) => x !== item);
  out.push(item);
  return out.slice(Math.max(0, out.length - limit));
};

const lastN = <T>(list: readonly T[], n: number) => list.slice(Math.max(0, list.length - n));

export const isToolAction = (action: SessionAction) =>
  action === "run_command" ||
  action === "read_file" ||
  action === "edit_file" ||
  action === "search" ||
  action === "web" ||
  action === "mcp" ||
  action === "wait" ||
  action === "other";

export const playedRun = (p: SessionPlay, at: number): SessionPlay => ({
  ...p,
  toolsThisRun: 0,
  runStartedAt: at,
  history: lastN([...p.history, { at, action: "thinking", label: "" }], historyLimit),
});

export function playedDoing(p: SessionPlay, f: FactDoing): SessionPlay {
  const history = p.history;
  const last = history[history.length - 1];
  if (last && last.action === f.action && last.label === f.label) return p;
  const next: SessionPlay = { ...p, history: lastN([...history, { at: f.at, action: f.action, label: f.label }], historyLimit) };
  if (!isToolAction(f.action)) return next;
  next.toolsThisRun = p.toolsThisRun + 1;
  next.counts = { ...p.counts, [f.action]: (p.counts[f.action] ?? 0) + 1 };
  if ((f.action === "edit_file" || f.action === "read_file") && f.label !== "") next.files = remember(p.files, f.label, fileLimit);
  else if (f.action === "run_command" && f.label !== "") next.commands = remember(p.commands, f.label, commandLimit);
  return next;
}

/** Only to a bed that is free on its own farm; a session already there, or a bed taken, changes nothing. */
export function stationed(state: WorkspaceState, f: FactStation): [WorkspaceState, boolean] {
  const h = sessionOf(state, f.id);
  if (!h || playOf(h).station === f.station) return [state, false];
  const others = state.sessions.filter((x) => x.id !== f.id);
  if (freeStation(others, farmOf(h), f.station) !== f.station) return [state, false];
  return withSession(state, f.id, (h) => ({ ...h, play: { ...playOf(h), station: f.station } }));
}
