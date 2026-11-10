import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type * as T from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import type { Execution, ExecutionObserver } from "#/executor/executor.ts";
import { lab } from "#/flows/farm.ts";

import { type Executions, linked } from "./link.ts";

const execution: Execution = {
  owner: { id: sessionId("w1"), agent: "lab", runtime: "pi" },
  sessionId: "oar-1",
  attached: true,
  closing: false,
  pendingTasks: 0,
};

it.effect("what crosses the link is a copy made of its JSON: nothing on one side is the other side's object", () =>
  Effect.gen(function* () {
    let watching: ExecutionObserver | undefined;
    const local: Executions = {
      start: () => Effect.succeed({ execution }),
      deliver: () => Effect.succeed({ kind: "accepted", landed: "prompted" }),
      interrupt: () => Effect.succeed({ kind: "failed", reason: "" }),
      close: () => Effect.void,
      failed: (_id, why) => Effect.succeed({ refused: why, retained: false }),
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
    const started = yield* remote.start({ agent: lab(), owner: execution.owner, cwd: "/w", input: "", resume: "", options: {} });
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
  }),
);
