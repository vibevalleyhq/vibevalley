// What the client gets. The words for people (a session's phaseText, a cron's
// whenText and nextText, the graphs' actions) are said here and only here, on a copy: reduce keeps the facts, so the
// words never reach the saved state.

import { t } from "@vibevalley/i18n";
import { type GraphAction, type Doing, type DoingView, type GameEffect, type StateFrame, type WorkspaceState, type WorkspaceView } from "@vibevalley/protocol";
import { phaseWords } from "@vibevalley/protocol/rules";

import { nextText, whenText } from "@/cron/when.ts";
import { viewOf } from "@/game/view.ts";
import { inbox } from "@/inbox/items.ts";
import { canEditTask, canRemoveTask, graphActions, taskActions } from "@/task/graph.ts";
import { graphsOf } from "@/task/issues.ts";

/** Every graph action in words, for the page to say any of them. */
const graphActionText = (): Record<GraphAction, string> => ({
  start: t("server.task.graphAction.start"),
  pause: t("server.task.graphAction.pause"),
  resume: t("server.task.graphAction.resume"),
  abandon: t("server.task.graphAction.abandon"),
  merge: t("server.task.graphAction.merge"),
});
export function frameOf(state: WorkspaceState, effects: GameEffect[] = [], seq = 0): StateFrame {
  const graphs = graphsOf(state).map((g) => {
    const graph = { ...g, stateTag: t(`server.task.graphTag.${g.state}`), actionText: graphActionText(), actions: graphActions(g) };
    if (graph.tasks.length === 0) return graph;
    graph.tasks = graph.tasks.map((n) => {
      const actions = taskActions(graph, n);
      return {
        ...n,
        stateText: t(`server.task.taskState.${n.state}`),
        actions,
        actionText: Object.fromEntries(actions.map((a) => [a, t(`server.task.taskAction.${a}`)])),
        canEdit: canEditTask(graph, n),
        canRemove: canRemoveTask(graph, n),
      };
    });
    return graph;
  });
  return { seq, state: withWords(state), inbox: inbox(state), graphs, view: viewOf(state), effects };
}

function withWords(state: WorkspaceState): WorkspaceView {
  const doing = (d: Doing): DoingView => ({ ...d, actionText: t(`shared.action.${d.action}`) });
  return {
    ...state,
    sessions: state.sessions.map(({ phase, play, ...h }) => ({
      ...h,
      phase: phase._tag === "working" ? { ...phase, doing: doing(phase.doing) } : phase,
      ...(play ? { play: { ...play, history: play.history.map((s) => ({ ...s, ...doing(s) })) } } : {}),
      phaseText: phaseWords({ ...h, phase }),
    })),
    crons: state.crons.map((s) => ({ ...s, whenText: whenText(s.when, s.tz), nextText: nextText(s) })),
  };
}
