// A task graph's calls, as both of its views carry them out: the workbench's (features/issue/TaskDetail.tsx) and the farm's
// (farm/panels/TaskBoard.tsx). Each answers in words, done or why not, and the issues are read again after either.

import type { GraphAction, GraphSplitRequest, TaskAction, TaskEdit } from "@vibevalley/protocol";

import { api, reasonOf } from "@/infra/api";
import { queries, useQuery } from "@/infra/query";

/** The server's answer to a task graph's call: ok, or the reason in its words. */
export interface Answer {
  readonly ok: boolean;
  readonly text: string;
}

const answer = async (call: () => Promise<string>): Promise<Answer> => {
  try {
    return { ok: true, text: await call() };
  } catch (e) {
    return { ok: false, text: reasonOf(e) };
  } finally {
    void queries.invalidateQueries({ queryKey: ["issues"] });
  }
};

export const graphs = {
  split: (request: GraphSplitRequest) => answer(() => api.graph.split(request)),
  act: (graph: string, action: GraphAction) => answer(() => api.graph.act({ id: graph, action })),
  taskAct: (graph: string, task: string, action: TaskAction) => answer(() => api.graph.task.act({ id: graph, task, action })),
  editTask: (graph: string, task: string, edit: TaskEdit) => answer(() => api.graph.task.update({ id: graph, task, ...edit })),
  removeTask: (graph: string, task: string) => answer(() => api.graph.task.delete({ id: graph, task })),
};

/** What the task graph's branch would bring into the main branch. */
export const useGraphChanges = (id: () => string) =>
  useQuery(() => ({ queryKey: ["issues", "graph-changes", id()], queryFn: () => api.graph.diff.get({ id: id() }) }));
