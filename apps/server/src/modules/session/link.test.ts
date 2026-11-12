import { expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { lab } from "#/flows/farm.ts";

import type { Execution, ExecutionObserver, Executions } from "./executor.ts";
import { linked } from "./link.ts";

const execution: Execution = {
  owner: { id: sessionId("w1"), agent: "lab", runtime: "pi" },
  sessionId: "oar-1",
  attached: true,
  closing: false,
  pendingTasks: 0,
};

test("what crosses the link is a copy made of its JSON: nothing on one side is the other side's object", async () => {
  {
    let watching: ExecutionObserver | undefined;
    const local: Executions = {
      start: () => Promise.resolve({ execution }),
      deliver: () => Promise.resolve({ kind: "accepted", landed: "prompted" }),
      interrupt: () => Promise.resolve({ kind: "failed", reason: "" }),
      close: () => Promise.resolve(),
      failed: (_id, why) => Promise.resolve({ refused: why, retained: false }),
      observe: (_id, observer) => {
        watching = observer;
      },
      detach: () => {},
      find: () => execution,
      all: () => [execution],
    };
    const remote = linked(local);
    expect(remote.find("w1")).toEqual(execution);
    expect(remote.find("w1")).not.toBe(execution);
    const started = await remote.start({ agent: lab(), owner: execution.owner, cwd: "/w", input: "", resume: "", options: {} });
    expect(started.execution).not.toBe(execution);
    const heard: T.ToolConnection[] = [];
    remote.observe("w1", {
      event: () => {},
      connection: (connection) => heard.push(connection),
      input: () => {},
      report: () => {},
      tasksChanged: () => {},
      stalled: () => {},
      stallMs: 1,
    });
    const told: T.ToolConnection = { server: "vibevalley", status: "ready" };
    watching?.connection(told);
    expect(heard).toEqual([told]);
    expect(heard[0]).not.toBe(told);
  }
});
