import { GraphActionValues, type GraphAction } from "@vibevalley/protocol";
import { t } from "@vibevalley/i18n";
// What the client gets. The words for people (a session's phaseText, a cron's
// whenText and nextText, the graphs' actions) are said here and only here, on a copy: reduce keeps the facts, so the
// words never reach the saved state.

import type { WorkspaceState, GameEffect, StateFrame } from "@vibevalley/protocol";
import { inbox } from "@/notice/inbox.ts";
import { phaseWords } from "@vibevalley/protocol/rules";
import { nextText, whenText } from "@/cron/when.ts";
import { graphsOf } from "@/task/issues.ts";
import { canEditTask, canRemoveTask, graphActions, taskActions } from "@/task/graph.ts";
import { viewOf } from "@/game/view.ts";

/** Every graph action in words, for the page to say any of them. */
const graphActionText = () => Object.fromEntries(GraphActionValues.map((a) => [a, t(`server.task.graphAction.${a}`)])) as Record<GraphAction, string>;
export function frameOf(state: WorkspaceState, effects: GameEffect[] = []): StateFrame {
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
  return { state: withWords(state), inbox: inbox(state), graphs, view: viewOf(state), effects };
}

function withWords(state: WorkspaceState): WorkspaceState {
  let next = state;
  if (state.sessions.length > 0) {
    next = {
      ...next,
      sessions: state.sessions.map((h) => {
        const out = { ...h, phaseText: phaseWords(h) };
        // The phase and the play are the state's: changed on copies.
        if (h.phase._tag === "working") out.phase = { ...h.phase, doing: { ...h.phase.doing, actionText: t(`shared.action.${h.phase.doing.action}`) } };
        if (h.play && (h.play.history ?? []).length > 0)
          out.play = { ...h.play, history: h.play.history.map((s) => ({ ...s, actionText: t(`shared.action.${s.action}`) })) };
        return out;
      }),
    };
  }
  if (state.crons.length > 0) next = { ...next, crons: state.crons.map((s) => ({ ...s, whenText: whenText(s.when, s.tz), nextText: nextText(s) })) };
  return next;
}
