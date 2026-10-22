import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { Agents } from "../agent/agent.ts";
import { seedAgents } from "../agent/seed.ts";
import { Issues } from "../issue/issue.ts";
import { Sessions } from "../session/session.ts";
import { testConfig } from "../testing/layers.ts";
import { world } from "../testing/world.ts";
import { Tasks } from "./task.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const until = (ready: () => boolean, what: string) =>
  Effect.promise(async () => {
    for (let n = 0; n < 500 && !ready(); n++) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!ready()) throw new Error("waited for " + what);
  });

describe("a task's workplace", () => {
  it.live("a rejected check releases the handover before asking the same session to fix it", () => {
    let turns = 0;
    const worker = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        turns++;
        const cwd = turn.options.cwd;
        const file = turns === 1 ? "attempt.txt" : "fixed.txt";
        writeFileSync(join(cwd, file), file + "\n");
        git(cwd, "add", file);
        git(cwd, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", file);
        turn.say("结论：做完了");
      },
    });
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const tasks = yield* Tasks;
      const agent = seedAgents().find((a) => a.id === "lab")!;
      yield* (yield* Agents).saveAgent({ ...agent, effort: "" });
      yield* issues.putTask({
        id: "p1",
        title: "retry checked work",
        goal: "keep the rejected work for its next run",
        project: "demo",
        state: "draft",
        parallel: 1,
        createdAt: Date.now(),
        tasks: [{ id: "only", title: "one step", brief: "write fixed work", needs: [], state: "waiting", tries: 0, agent: "lab", check: "test -f fixed.txt" }],
      });
      yield* tasks.act("p1", "start", "user");
      yield* until(() => tasks.graphs()[0]?.state === "ripe", "the same session fixing its rejected work");
      expect(turns).toBe(2);
      expect(tasks.graphs()[0]!.tasks[0]).toMatchObject({ state: "merged", tries: 1 });
      expect((yield* tasks.events("p1")).some((event) => event.kind === "task_sent_back" && event.detail === "做完跑 test -f fixed.txt 没通过")).toBe(true);
      expect((yield* sessions.list("lab")).map((s) => s.id)).toEqual(["w1"]);
    }).pipe(Effect.scoped, Effect.provide(world({ runtimes: [worker], repos: ["demo"] })));
  });

  it.live("acceptance holds only its session while another can work and stop", () => {
    const config = testConfig();
    const started = join(config.home, "check-started");
    const release = join(config.home, "check-release");
    const worker = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        if (turn.input.includes("other session")) {
          if (turn.input.includes("keep busy")) await new Promise<void>((resolve) => turn.signal.addEventListener("abort", () => resolve()));
          else turn.say("结论：等下一轮");
          return;
        }
        const cwd = turn.options.cwd;
        const file = turn.input.includes("unverified followup") ? "unchecked.txt" : "checked.txt";
        writeFileSync(join(cwd, file), file + "\n");
        git(cwd, "add", file);
        git(cwd, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", file);
        turn.say("结论：做完了");
      },
    });
    return Effect.gen(function* () {
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const tasks = yield* Tasks;
      const agent = seedAgents().find((a) => a.id === "lab")!;
      yield* (yield* Agents).saveAgent({ ...agent, effort: "" });
      const other = (yield* issues.hire({ ...agent, effort: "" }, "other session", "other")).session!;
      yield* until(() => sessions.sessionOf(other.id)?.phase._tag === "ripe", "the other session's first report");
      yield* issues.putTask({
        id: "p1",
        title: "checked work",
        goal: "accept exactly the work checked",
        project: "demo",
        state: "draft",
        parallel: 1,
        createdAt: Date.now(),
        tasks: [
          {
            id: "only",
            title: "one step",
            brief: "write checked work",
            needs: [],
            state: "waiting",
            tries: 0,
            agent: "lab",
            check: `test ! -e unchecked.txt && touch '${started}' && while [ ! -e '${release}' ]; do sleep 0.01; done`,
          },
        ],
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => writeFileSync(release, "release\n")));
      yield* tasks.act("p1", "start", "user");
      yield* until(() => existsSync(started), "acceptance checking the worktree");
      const session = tasks.graphs()[0]!.tasks[0]!.session!;
      const delivery = yield* Effect.forkScoped(sessions.deliver(session, "unverified followup", { kind: "comment" }));
      const continuing = yield* sessions.deliver(other.id, "other session keep busy", { kind: "comment" }).pipe(Effect.timeout(1000));
      expect(continuing.kind).toBe("run");
      yield* until(() => sessions.sessionOf(other.id)?.phase._tag === "working", "the other session working during acceptance");
      expect(yield* sessions.stop(other.id)).toBe(true);
      // A delivery can complete here only if acceptance does not own the session.
      yield* Effect.sleep(200);
      writeFileSync(release, "release\n");
      yield* until(() => tasks.graphs()[0]?.state === "ripe", "the checked step being merged");
      expect((yield* Fiber.join(delivery)).kind).toBe("refused");
      const graph = tasks.graphs()[0]!;
      expect(git(join(config.workRoot, "projects", "demo"), "ls-tree", "--name-only", graph.branch!)).not.toContain("unchecked.txt");
    }).pipe(Effect.scoped, Effect.provide(world({ config, runtimes: [worker], repos: ["demo"] })));
  });
});
