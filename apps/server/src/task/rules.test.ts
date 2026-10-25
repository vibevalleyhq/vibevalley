import type { TaskEdit, TaskGraph } from "@vibevalley/protocol";
import { expect, test } from "vite-plus/test";
import { checkCases, goldenCases } from "../testing/golden.ts";
import {
  acceptancePassedText,
  allSettled,
  checkFailedText,
  editTask,
  type EditResult,
  frozenTouched,
  frozenTouchedText,
  parseSplit,
  removeTask,
  startable,
  taskBrief,
} from "./rules.ts";

const edited = (e: EditResult) => (e.ok ? { ok: true, task: e.graph } : { ok: false, problem: e.problem });

test("the recorded cases", () => {
  const cases = goldenCases("task");
  expect(new Set(cases.map((c) => c.fn))).toEqual(new Set(["task", "split"]));
  const failed = checkCases(cases, (c) => {
    if (c.fn === "split") {
      const got = parseSplit(c.in as string);
      return got.ok ? { ok: true, tasks: got.tasks, ...(got.title !== undefined ? { title: got.title } : {}) } : { ok: false, problems: got.problems };
    }
    const i = c.in as {
      task: TaskGraph;
      edit: TaskEdit;
      id: string;
      output: string;
      index: number;
    };
    const graph = { ...i.task, tasks: i.task.tasks ?? [] };
    return {
      startable: startable(graph).map((n) => n.id),
      settled: allSettled(graph),
      brief: i.index < graph.tasks.length ? taskBrief(graph, graph.tasks[i.index]!) : null,
      checkFailed: checkFailedText("pnpm test", i.output),
      frozenTouched: graph.tasks.map((n) => frozenTouched(graph, n, ["test/a_test.go", "src/x.ts", "README.md"])),
      acceptancePassed: acceptancePassedText(i.output),
      frozenText: frozenTouchedText(["test/a_test.go", i.output]),
      edited: edited(editTask(graph, i.id, i.edit ?? {})),
      removed: edited(removeTask(graph, i.id)),
    };
  });
  expect(failed.slice(0, 5)).toEqual([]);
});
