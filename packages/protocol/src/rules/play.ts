// Where each session stands and what it has been doing, for the farm to draw:
// no business rule reads a session's play.

import { type CoreState, type FactDoing, type FactStation, maxRunning, type Session, type SessionAction, type SessionPlay } from "../shapes";
import { sessionOf, withSession } from "./sessions";

export const historyLimit = 30;
export const fileLimit = 24;
export const commandLimit = 12;

/** One saved before plays were kept has an empty one, with no bed. */
export const playOf = (h: Session): SessionPlay => h.play ?? { station: -1, history: [], toolsThisRun: 0, counts: {}, files: [], commands: [] };

export function freeStation(sessions: readonly Session[], prefer?: number): number {
  const taken = new Set(sessions.map((h) => playOf(h).station));
  if (prefer !== undefined && prefer >= 0 && prefer < maxRunning && !taken.has(prefer)) return prefer;
  for (let i = 0; i < maxRunning; i++) if (!taken.has(i)) return i;
  return -1;
}

export function withStations(state: CoreState): CoreState {
  if (!state.sessions.some((h) => playOf(h).station < 0)) return state;
  const placed = state.sessions.filter((h) => playOf(h).station >= 0);
  for (const h of state.sessions) {
    if (playOf(h).station >= 0) continue;
    placed.push({ ...h, play: { ...playOf(h), station: freeStation(placed) } });
  }
  return { ...state, sessions: state.sessions.map((h) => placed.find((x) => x.id === h.id) ?? h) };
}

const remember = (list: readonly string[] | null | undefined, item: string, limit: number) => {
  const out = (list ?? []).filter((x) => x !== item);
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
  history: lastN([...(p.history ?? []), { at, action: "thinking", label: "" }], historyLimit),
});

export function playedDoing(p: SessionPlay, f: FactDoing): SessionPlay {
  const history = p.history ?? [];
  const last = history[history.length - 1];
  if (last && last.action === f.action && last.label === f.label) return p;
  const next: SessionPlay = { ...p, history: lastN([...history, { at: f.at, action: f.action, label: f.label }], historyLimit) };
  if (!isToolAction(f.action)) return next;
  next.toolsThisRun = p.toolsThisRun + 1;
  next.counts = { ...p.counts, [f.action]: (p.counts?.[f.action] ?? 0) + 1 };
  if ((f.action === "edit_file" || f.action === "read_file") && f.label !== "") next.files = remember(p.files, f.label, fileLimit);
  else if (f.action === "run_command" && f.label !== "") next.commands = remember(p.commands, f.label, commandLimit);
  return next;
}

/** Only to a bed that is free; a session already there, or a bed taken, changes nothing. */
export function stationed(state: CoreState, f: FactStation): [CoreState, boolean] {
  const h = sessionOf(state, f.id);
  if (!h || playOf(h).station === f.station) return [state, false];
  const others = state.sessions.filter((x) => x.id !== f.id);
  if (freeStation(others, f.station) !== f.station) return [state, false];
  return withSession(state, f.id, (h) => ({ ...h, play: { ...playOf(h), station: f.station } }));
}
