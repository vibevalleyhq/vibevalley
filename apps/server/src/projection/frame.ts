// What the client gets. The words for people (a session's phaseText, a schedule's
// whenText and nextText, the graphs' actions) are said here and only here, on a copy: reduce keeps the facts, so the
// words never reach the saved state.

import type { CoreState, GameEffect, StateFrame } from "@vibevalley/protocol";
import { inbox } from "../notice/inbox.ts";
import { actionText, phaseWords } from "@vibevalley/protocol/rules";
import { nextText, whenText } from "../schedule/when.ts";
import { graphsOf } from "../task/issues.ts";
import { canEditTask, canRemoveTask, graphActions, graphActionText, graphStateTag, taskActions, taskActionText, taskStateText } from "../task/graph.ts";
import { viewOf } from "../game/view.ts";

export function frameOf(state: CoreState, effects: GameEffect[] = []): StateFrame {
  const graphs = graphsOf(state).map((g) => {
    const graph = { ...g, stateTag: graphStateTag[g.state], actionText: { ...graphActionText }, actions: graphActions(g) };
    if (graph.tasks.length === 0) return graph;
    graph.tasks = graph.tasks.map((n) => {
      const actions = taskActions(graph, n);
      return {
        ...n,
        stateText: taskStateText[n.state],
        actions,
        actionText: Object.fromEntries(actions.map((a) => [a, taskActionText[a]])),
        canEdit: canEditTask(graph, n),
        canRemove: canRemoveTask(graph, n),
      };
    });
    return graph;
  });
  return { state: withWords(state), inbox: inbox(state), graphs, view: viewOf(state), effects };
}

function withWords(state: CoreState): CoreState {
  let next = state;
  if (state.sessions.length > 0) {
    next = {
      ...next,
      sessions: state.sessions.map((h) => {
        const out = { ...h, phaseText: phaseWords(h) };
        // The phase and the play are the state's: changed on copies.
        if (h.phase._tag === "working") out.phase = { ...h.phase, doing: { ...h.phase.doing, actionText: actionText[h.phase.doing.action] } };
        if (h.play && (h.play.history ?? []).length > 0)
          out.play = { ...h.play, history: h.play.history.map((s) => ({ ...s, actionText: actionText[s.action] })) };
        return out;
      }),
    };
  }
  if ((state.schedules ?? []).length > 0)
    next = { ...next, schedules: state.schedules!.map((s) => ({ ...s, whenText: whenText(s.when, s.tz), nextText: nextText(s) })) };
  return next;
}
