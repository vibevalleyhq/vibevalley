import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import { expect, test } from "vite-plus/test";

import type { SessionNews } from "#/modules/session/signals.ts";
import { testIssues } from "#/testing/world.ts";

import { await_, farm, lab, until } from "./farm.ts";

for (const mode of ["settle", "handoff", "stop", "failed", "late"] as const) {
  const handoff = mode === "handoff";
  test(
    handoff
      ? "regression: explicit handoff releases capacity while the preview task remains open"
      : mode === "late"
        ? "regression: a handoff arriving during settling releases capacity without closing the preview"
        : mode === "stop"
          ? "regression: stopping a settling session disposes background work before releasing capacity"
          : mode === "failed"
            ? "regression: a failed background task cannot turn a settling run into a successful handoff"
            : "regression: a completed turn holds capacity until its background task settles",
    async () => {
      const finish = Promise.withResolvers<void>();
      let task: ReturnType<ScriptedTurn["task"]> | undefined;
      let child: ReturnType<ScriptedTurn["task"]> | undefined;
      const f = farm({
        change: (config) => ({ ...config, repo: { ...config.repo, maxSessions: 1 } }),
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
      await using fw = await f.open();
      const sessions = fw.session;
      const machines = fw.session;
      const executor = machines.executions(machines.here());
      const issue2 = fw.issue;
      const issues = testIssues(issue2);
      const events: SessionNews[] = [];
      using news = sessions.news();
      const reading = (async () => {
        for await (const event of news) events.push(event);
      })();
      // The reader ends with its subscription, as the test ends.
      reading.catch(() => {});
      await fw.agent.save(lab());
      const issue = await issues.add({ title: "work", repo: "background", agent: "lab" });
      const sent = await issues.start(issue.id, "");
      const id = sent.session!;
      await until(() => task !== undefined && sessions.runOf(id) !== undefined, "a background task and open run");
      if (handoff) await sessions.report(id, { summary: "preview ready", questions: [], checks: [], remember: [], prSubmit: false });
      finish.resolve();
      await until(() => events.some((event) => event._tag === (handoff ? "HandedOff" : "Settling")), "the end-of-turn signal");
      expect(executor.find(id)?.pendingTasks).toBe(child ? 2 : 1);
      expect(sessions.sessionOf(id)?.phase._tag).toBe(handoff ? "done" : "working");
      expect(sessions.noRoom("pi", "background") === "").toBe(handoff);
      if (handoff)
        await await_(
          () => sessions.issueRuns(issue.id),
          (runs) => runs[0]?.endedAt !== undefined,
          "the persisted handoff",
        );
      else expect((await sessions.issueRuns(issue.id))[0]?.endedAt).toBeUndefined();
      if (mode === "late") {
        await sessions.report(id, { summary: "preview ready", questions: [], checks: [], remember: [], prSubmit: false });
        await until(() => sessions.sessionOf(id)?.phase._tag === "done", "the late handoff");
        expect(executor.find(id)?.pendingTasks).toBe(1);
        expect(sessions.noRoom("pi", "background")).toBe("");
      }
      if (mode === "stop") {
        const stopped = await sessions.stop(id);
        expect(stopped).toBe(true);
        await until(() => sessions.sessionOf(id)?.phase._tag === "resting", "the stopped session");
        expect(executor.find(id)).toBeUndefined();
        expect(sessions.noRoom("pi", "background")).toBe("");
        task!.end();
        expect(events.filter((event) => event._tag === "HandedOff")).toHaveLength(0);
        return;
      }
      task!.end(mode === "failed" ? "failed" : "completed", { summary: mode === "failed" ? "build failed" : "finished" });
      if (child) {
        await until(() => executor.find(id)?.pendingTasks === 1, "only the child remains");
        expect(sessions.sessionOf(id)?.phase._tag).toBe("working");
        expect(sessions.noRoom("pi", "background")).not.toBe("");
        child.end();
      }
      await until(
        () => executor.find(id)?.pendingTasks === 0 && sessions.sessionOf(id)?.phase._tag === (mode === "failed" ? "failed" : "done"),
        "the background task settled",
      );
      expect(sessions.noRoom("pi", "background")).toBe("");
      expect(events.filter((event) => event._tag === "HandedOff")).toHaveLength(mode === "failed" ? 0 : 1);
      expect(executor.find(id)?.attached).toBe(true);
    },
  );
}
