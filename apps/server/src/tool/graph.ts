import { Effect } from "effect";

import type * as T from "@vibevalley/protocol";

import { isOpen } from "@/task/graph.ts";
import { graphText } from "@/task/prompts.ts";
import { Task } from "@/task/task.ts";

import { type Who, type Orchestrator, type SessionInput, callerOf, answered, tool, sessionSchemaTool } from "./definition.ts";
import { answers } from "./prompts.ts";

export const graphTools = Effect.gen(function* () {
  const tasks = yield* Task;

  const graphSplit = (who: Who) =>
    tool(
      "graph.split",
      Effect.fn("Tool.graphSplit")(function* (p: Orchestrator<"graph.split">) {
        const c = yield* callerOf(who);
        return yield* answered(tasks.split(p.goal, p.project, p.agent ?? "", c.actor));
      }),
    );

  const graphList = tool("graph.list", () =>
    Effect.sync(() => {
      const texts = tasks.graphs().filter(isOpen).map(graphText);
      return texts.length > 0 ? texts.join("\n\n") : answers.graphs.none;
    }),
  );

  const graphGet = tool("graph.get", (p: Orchestrator<"graph.get">) => answered(Effect.map(tasks.graph(p.id.trim()), graphText)));

  const taskUpdate = (who: Who) =>
    tool(
      "graph.task.update",
      Effect.fn("Tool.taskUpdate")(function* (p: Orchestrator<"graph.task.update">) {
        const by = (yield* callerOf(who)).actor;
        const edit: T.TaskEdit = {
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.brief !== undefined ? { brief: p.brief } : {}),
          ...(p.needs !== undefined ? { needs: p.needs } : {}),
          ...(p.agent !== undefined ? { agent: p.agent } : {}),
          ...(p.check !== undefined ? { check: p.check } : {}),
        };
        return yield* answered(tasks.editTask(p.id, p.task, edit, by));
      }),
    );

  const taskDelete = (who: Who) =>
    tool(
      "graph.task.delete",
      Effect.fn("Tool.taskDelete")(function* (p: Orchestrator<"graph.task.delete">) {
        const by = (yield* callerOf(who)).actor;
        return yield* answered(tasks.removeTask(p.id, p.task, by));
      }),
    );

  const graphAct = (who: Who) =>
    tool(
      "graph.act",
      Effect.fn("Tool.graphAct")(function* (p: Orchestrator<"graph.act">) {
        const c = yield* callerOf(who);
        return yield* answered(tasks.act(p.id, p.action, c.actor));
      }),
    );

  const taskAct = (who: Who) =>
    tool(
      "graph.task.act",
      Effect.fn("Tool.taskAct")(function* (p: Orchestrator<"graph.task.act">) {
        const c = yield* callerOf(who);
        return yield* answered(tasks.taskAct(p.id, p.task, p.action, c.actor));
      }),
    );

  const issueSplit = (who: Who) =>
    sessionSchemaTool(
      "issue.split",
      Effect.fn("Tool.issueSplit")(function* (p: SessionInput<"issue.split">) {
        const c = yield* callerOf(who);
        const drafts = p.tasks.map((item) => ({
          id: item.id,
          title: item.title ?? "",
          brief: item.brief,
          ...(item.needs ? { needs: item.needs } : {}),
          agent: item.agent ?? "",
          check: item.check ?? "",
          ...(item.scope ? { scope: item.scope } : {}),
          ...(item.acceptance === true ? { acceptance: true } : {}),
        }));
        return yield* answered(tasks.splitIssue(c.session, p.title ?? "", drafts));
      }),
    );
  return { graphSplit, graphList, graphGet, taskUpdate, taskDelete, graphAct, taskAct, issueSplit };
});
