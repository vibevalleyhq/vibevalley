import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import { expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";

import { Agent } from "@/agent/agent.ts";
import { Executor } from "@/executor/executor.ts";
import { Issue } from "@/issue/issue.ts";
import { Session } from "@/session/session.ts";
import type { LaunchActivity } from "@/session/signals.ts";
import { testIssues } from "@/testing/world.ts";

import { await_, farm, lab, until } from "./farm.ts";

for (const mode of ["settle", "handoff", "stop", "failed", "late"] as const) {
  const handoff = mode === "handoff";
  it.live(
    handoff
      ? "regression: explicit handoff releases capacity while the preview task remains open"
      : mode === "late"
        ? "regression: a handoff arriving during settling releases capacity without closing the preview"
        : mode === "stop"
          ? "regression: stopping a settling session disposes background work before releasing capacity"
          : mode === "failed"
            ? "regression: a failed background task cannot turn a settling run into a successful handoff"
            : "regression: a completed turn holds capacity until its background task settles",
    () => {
      const finish = Promise.withResolvers<void>();
      let task: ReturnType<ScriptedTurn["task"]> | undefined;
      let child: ReturnType<ScriptedTurn["task"]> | undefined;
      const f = farm({
        change: (config) => ({ ...config, project: { ...config.project, maxSessions: 1 } }),
        runtime: scriptedRuntime({
          id: "pi",
          turn: async (turn) => {
            task = turn.task({ taskType: "shell", background: true, description: handoff ? "preview" : "build" });
            if (mode === "settle" || mode === "failed") child = turn.task({ taskType: "agent", background: true, description: "child work" });
            turn.say("ready");
            await finish.promise;
          },
        }),
      });
      return Effect.gen(function* () {
        const sessions = yield* Session;
        const executor = yield* Executor;
        const issues = testIssues(yield* Issue);
        const events: LaunchActivity[] = [];
        yield* Effect.forkScoped(Stream.runForEach(yield* sessions.launches, (event) => Effect.sync(() => events.push(event))));
        yield* (yield* Agent).save(lab());
        const issue = yield* issues.add({ title: "work", project: "background", agent: "lab" });
        const sent = yield* issues.start(issue.id, "");
        const id = sent.session!;
        yield* until(() => task !== undefined && sessions.runOf(id) !== undefined, "a background task and open run");
        if (handoff) yield* sessions.report(id, { summary: "preview ready", questions: [], checks: [], remember: [], prSubmit: false });
        finish.resolve();
        yield* until(() => events.some((event) => event.kind === (handoff ? "handedOff" : "settling")), "the end-of-turn signal");
        expect(executor.find(id)?.pendingTasks).toBe(child ? 2 : 1);
        expect(sessions.sessionOf(id)?.phase._tag).toBe(handoff ? "done" : "working");
        expect(sessions.noRoom("pi", "background") === "").toBe(handoff);
        if (handoff)
          yield* await_(
            () => sessions.issueRuns(issue.id),
            (runs) => runs[0]?.endedAt !== undefined,
            "the persisted handoff",
          );
        else expect((yield* sessions.issueRuns(issue.id))[0]?.endedAt).toBeUndefined();
        if (mode === "late") {
          yield* sessions.report(id, { summary: "preview ready", questions: [], checks: [], remember: [], prSubmit: false });
          yield* until(() => sessions.sessionOf(id)?.phase._tag === "done", "the late handoff");
          expect(executor.find(id)?.pendingTasks).toBe(1);
          expect(sessions.noRoom("pi", "background")).toBe("");
        }
        if (mode === "stop") {
          expect(yield* sessions.stop(id)).toBe(true);
          yield* until(() => sessions.sessionOf(id)?.phase._tag === "resting", "the stopped session");
          expect(executor.find(id)).toBeUndefined();
          expect(sessions.noRoom("pi", "background")).toBe("");
          task!.end();
          expect(events.filter((event) => event.kind === "handedOff")).toHaveLength(0);
          return;
        }
        task!.end(mode === "failed" ? "failed" : "completed", { summary: mode === "failed" ? "build failed" : "finished" });
        if (child) {
          yield* until(() => executor.find(id)?.pendingTasks === 1, "only the child remains");
          expect(sessions.sessionOf(id)?.phase._tag).toBe("working");
          expect(sessions.noRoom("pi", "background")).not.toBe("");
          child.end();
        }
        yield* until(
          () => executor.find(id)?.pendingTasks === 0 && sessions.sessionOf(id)?.phase._tag === (mode === "failed" ? "failed" : "done"),
          "the background task settled",
        );
        expect(sessions.noRoom("pi", "background")).toBe("");
        expect(events.filter((event) => event.kind === "handedOff")).toHaveLength(mode === "failed" ? 0 : 1);
        expect(executor.find(id)?.attached).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(f.layer));
    },
  );
}
