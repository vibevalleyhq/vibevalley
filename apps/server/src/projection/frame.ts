// What the client gets. The words for people (a session's phaseText, a cron's
// whenText and nextText, the graphs' actions) are said here and only here, on a copy: reduce keeps the facts, so the
// words never reach the saved state.

import { t } from "@vibevalley/i18n";
import { type Doing, type DoingView, type GameEffect, type StateFrame, type WorkspaceState, type WorkspaceView } from "@vibevalley/protocol";
import { phaseWords } from "@vibevalley/protocol/rules";

import { nextText, whenText } from "@/cron/when.ts";
import { viewOf } from "@/game/view.ts";
import { inbox } from "@/inbox/items.ts";

export function frameOf(state: WorkspaceState, effects: GameEffect[] = [], seq = 0): StateFrame {
  return { seq, state: withWords(state), inbox: inbox(state), view: viewOf(state), effects };
}

function withWords(state: WorkspaceState): WorkspaceView {
  const doing = (d: Doing): DoingView => ({ ...d, actionText: t(`shared.action.${d.action}`) });
  const { plays: _plays, ...rest } = state;
  return {
    ...rest,
    sessions: state.sessions.map(({ phase, ...h }) => ({
      ...h,
      phase: phase._tag === "working" ? { ...phase, doing: doing(phase.doing) } : phase,
      phaseText: phaseWords({ ...h, phase }, state.issues.find((issue) => issue.id === h.issue)?.conflict),
    })),
    crons: state.crons.map((s) => ({ ...s, whenText: whenText(s.when, s.tz), nextText: nextText(s) })),
  };
}
