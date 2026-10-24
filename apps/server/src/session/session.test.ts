import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import type { Agent, Session } from "@vibevalley/protocol";
import { seedAgents } from "../agent/seed.ts";
import { Agents } from "../agent/agent.ts";
import { Effect, Exit, Fiber, Semaphore, Stream } from "effect";
import { Core } from "../core/core.ts";
import { MergeFailure, Projects } from "../project/project.ts";
import { testConfig } from "../testing/layers.ts";
import { world } from "../testing/world.ts";
import { type LaunchActivity } from "../channel/chat.ts";
import { Sessions, type SessionsInside } from "./session.ts";
import { until } from "../testing/until.ts";

const lab = (): Agent => ({ ...seedAgents().find((a) => a.id === "lab")!, effort: "" });

/** A helper that writes a file, commits it and reports, as the farm's rules ask. */
const worker = (turns: ScriptedTurn[]) =>
  scriptedRuntime({
    id: "pi",
    turn: async (turn) => {
      turns.push(turn);
      await turn.tool("bash", JSON.stringify({ command: `cd ${turn.options.cwd} && touch done.txt` }), () => {
        writeFileSync(join(turn.options.cwd, `done-${turns.length}.txt`), "done\n");
        execFileSync("git", ["-c", "user.name=w", "-c", "user.email=w@x", "add", "-A"], { cwd: turn.options.cwd });
        execFileSync("git", ["-c", "user.name=w", "-c", "user.email=w@x", "commit", "-qm", `做完第 ${turns.length} 轮`], { cwd: turn.options.cwd });
        return "ok";
      });
      turn.say(`改好了。\n\n记住：这个项目用 pnpm test\n\n结论：做完了第 ${turns.length} 轮`);
    },
  });

const phase = (core: Core["Service"], id: string) => core.session(id)?.phase._tag;

const idleWorker = () =>
  scriptedRuntime({
    id: "pi",
    turn: async (turn) => {
      if (turn.signal.aborted) return;
      await new Promise<void>((resolve) => turn.signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("sessions", () => {
  it.live("a slow events reader holds oar callbacks without losing the final report", () => {
    const reading = deferred();
    const release = deferred();
    const worked = deferred();
    const runtime = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        for (let n = 0; n < 40; n++) await turn.tool("bash", JSON.stringify({ command: `echo ${n}` }), () => String(n));
        worked.resolve();
        turn.say("结论：慢读者恢复以后交回");
      },
    });
    return Effect.gen(function* () {
      const sessions = yield* Sessions;
      const core = yield* Core;
      const reports: string[] = [];
      yield* core.events.pipe(
        Stream.runForEach((e) => {
          if (e.type === "snapshot") {
            reading.resolve();
            return Effect.promise(() => release.promise);
          }
          if (e.type === "report" && e.summary === "慢读者恢复以后交回") reports.push(e.summary);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* Effect.promise(() => reading.promise);
      const hired = yield* sessions.send(lab(), "flood the slow reader", "demo", { issue: { id: "slow-reader", number: 1 }, worktree: true });
      const id = hired.session!.id;
      yield* Effect.promise(() => worked.promise);
      yield* Effect.yieldNow;
      expect(phase(core, id)).not.toBe("done");
      release.resolve();
      yield* until(() => phase(core, id) === "done" && core.session(id)?.lastRun?.summary === "慢读者恢复以后交回", "the report after the reader resumes");
      expect(reports).toEqual(["慢读者恢复以后交回"]);
    }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())), Effect.scoped, Effect.provide(world({ runtimes: [runtime], repos: ["demo"] })));
  });

  it.live("interrupting a send before its core commit releases every startup resource", () => {
    const base = idleWorker();
    const reading = deferred();
    const release = deferred();
    let disposals = 0;
    let capturedCwd = "";
    let capturedToken = "";
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        capturedCwd = args[1].cwd;
        capturedToken = ((args[1].mcpServers![0] as { headers: Record<string, string> }).headers.authorization ?? "").replace("Bearer ", "");
        const session = await base.session(...args);
        return {
          ...session,
          dispose: async () => {
            disposals++;
            await session.dispose();
          },
        };
      },
    };
    return Effect.gen(function* () {
      const sessions = yield* Sessions;
      const core = yield* Core;
      const s = sessions as SessionsInside;
      yield* core.events.pipe(
        Stream.runForEach((e) => {
          if (e.type === "snapshot") {
            reading.resolve();
            return Effect.promise(() => release.promise);
          }
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* Effect.promise(() => reading.promise);
      for (let total = 0; total < 64; total++) yield* core.setCommits({ total } as never);
      const blocked = yield* Effect.forkChild(core.setCommits({ total: 64 } as never), { startImmediately: true });
      yield* Effect.yieldNow;
      expect(core.state().commits?.total).toBe(64);
      const sending = yield* Effect.forkChild(sessions.send(lab(), "cancel before hired", "demo", { issue: { id: "i1", number: 1 }, worktree: true }), {
        startImmediately: true,
      });
      yield* until(() => s.hands.has("w1"), "the attached but uncommitted session");
      yield* Fiber.interrupt(sending);
      expect(Exit.hasInterrupts(yield* Fiber.await(sending))).toBe(true);
      expect(disposals).toBe(1);
      expect(core.session("w1")).toBeUndefined();
      expect(s.hands.has("w1")).toBe(false);
      expect(sessions.who(capturedToken)).toBe("");
      expect(capturedToken).not.toBe("");
      expect(existsSync(capturedCwd)).toBe(false);
      expect(sessions.noRoom("pi", "demo")).toBe("");
      release.resolve();
      yield* Fiber.join(blocked);
    }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())), Effect.scoped, Effect.provide(world({ runtimes: [runtime], repos: ["demo"] })));
  });

  it.live("interrupting a pending spawn disposes the late session and lets the issue retry", () => {
    const base = worker([]);
    const sessionStarted = deferred();
    const sessionGate = deferred();
    let opens = 0;
    let disposals = 0;
    let capturedCwd = "";
    let capturedToken = "";
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        const first = ++opens === 1;
        if (first) {
          capturedCwd = args[1].cwd;
          capturedToken = ((args[1].mcpServers![0] as { headers: Record<string, string> }).headers.authorization ?? "").replace("Bearer ", "");
          sessionStarted.resolve();
          await sessionGate.promise;
        }
        const session = await base.session(...args);
        if (!first) return session;
        return {
          ...session,
          dispose: async () => {
            disposals++;
            await session.dispose();
          },
        };
      },
    };
    return Effect.gen(function* () {
      const sessions = yield* Sessions;
      const core = yield* Core;
      const sending = yield* Effect.forkChild(sessions.send(lab(), "interrupted spawn", "demo", { issue: { id: "i1", number: 1 }, worktree: true }), {
        startImmediately: true,
      });
      yield* Effect.promise(() => sessionStarted.promise);
      // Interruption waits for cleanup, and cleanup waits for the late runtime session.
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(sending), { startImmediately: true });
      yield* Effect.yieldNow;
      sessionGate.resolve();
      const exit = yield* Fiber.await(sending);
      yield* Fiber.join(interrupting);
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(disposals).toBe(1);
      expect(capturedCwd).not.toBe("");
      expect(capturedToken).not.toBe("");
      expect(existsSync(capturedCwd)).toBe(false);
      expect(sessions.who(capturedToken)).toBe("");
      expect(sessions.noRoom("pi", "demo")).toBe("");

      const retried = yield* sessions.send(lab(), "retry after interruption", "demo", { issue: { id: "i1", number: 1 }, worktree: true });
      expect(retried.refused).toBeUndefined();
      expect(retried.session).toBeDefined();
      expect(opens).toBe(2);
      yield* until(() => phase(core, retried.session!.id) === "done", "the retried report");
    }).pipe(Effect.scoped, Effect.provide(world({ runtimes: [runtime], repos: ["demo"] })));
  });

  it.live("interrupting hiring closes the allocation, journal, token and workplace", () => {
    const base = idleWorker();
    const hiringStarted = deferred();
    const hiringGate = deferred();
    let disposals = 0;
    let capturedCwd = "";
    let capturedToken = "";
    let openingId = "";
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        capturedCwd = args[1].cwd;
        capturedToken = ((args[1].mcpServers![0] as { headers: Record<string, string> }).headers.authorization ?? "").replace("Bearer ", "");
        const session = await base.session(...args);
        return {
          ...session,
          dispose: async () => {
            disposals++;
            await session.dispose();
          },
        };
      },
    };
    return Effect.gen(function* () {
      const sessions = yield* Sessions;
      const core = yield* Core;
      const s = sessions as SessionsInside;
      const finished: string[] = [];
      const finish = s.trajectories.finish.bind(s.trajectories);
      s.trajectories.finish = (id) => {
        finished.push(id);
        finish(id);
      };
      const sending = yield* Effect.forkChild(
        sessions.send(lab(), "interrupted hiring", "demo", {
          issue: { id: "i1", number: 1 },
          worktree: true,
          hiring: (session) => {
            openingId = session.id;
            hiringStarted.resolve();
            return Effect.promise(() => hiringGate.promise);
          },
        }),
        { startImmediately: true },
      );
      yield* Effect.promise(() => hiringStarted.promise);
      yield* Fiber.interrupt(sending);
      const exit = yield* Fiber.await(sending);
      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(openingId).toBe("w1");
      expect(disposals).toBe(1);
      expect(finished).toEqual([openingId]);
      expect(s.hands.has(openingId)).toBe(false);
      expect(core.session(openingId)).toBeUndefined();
      expect(sessions.who(capturedToken)).toBe("");
      expect(existsSync(capturedCwd)).toBe(false);
      expect(sessions.noRoom("pi", "demo")).toBe("");
    }).pipe(Effect.scoped, Effect.provide(world({ runtimes: [runtime], repos: ["demo"] })));
  });

  it.live("hiring preserves defects and treats typed failures as ordinary refusals", () => {
    const base = idleWorker();
    const boom = new Error("boom");
    const cwds: string[] = [];
    const tokens: string[] = [];
    let disposals = 0;
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        cwds.push(args[1].cwd);
        tokens.push(((args[1].mcpServers![0] as { headers: Record<string, string> }).headers.authorization ?? "").replace("Bearer ", ""));
        const session = await base.session(...args);
        return {
          ...session,
          dispose: async () => {
            disposals++;
            await session.dispose();
          },
        };
      },
    };
    return Effect.gen(function* () {
      const sessions = yield* Sessions;
      const known = yield* sessions.send(lab(), "known failure", "demo", {
        issue: { id: "known", number: 1 },
        worktree: true,
        hiring: () => Effect.fail(new Error("known hiring failure")),
      });
      expect(known.refused).toContain("known hiring failure");
      expect(known.session).toBeUndefined();
      expect(disposals).toBe(1);
      expect(sessions.who(tokens[0]!)).toBe("");
      expect(existsSync(cwds[0]!)).toBe(false);
      expect(sessions.noRoom("pi", "demo")).toBe("");

      const exit = yield* Effect.exit(
        sessions.send(lab(), "defect", "demo", {
          issue: { id: "defect", number: 2 },
          worktree: true,
          hiring: () => Effect.die(boom),
        }),
      );
      expect(Exit.hasDies(exit)).toBe(true);
      expect(Exit.hasFails(exit)).toBe(false);
      expect(disposals).toBe(2);
      expect(sessions.who(tokens[1]!)).toBe("");
      expect(existsSync(cwds[1]!)).toBe(false);
      expect(sessions.noRoom("pi", "demo")).toBe("");
    }).pipe(Effect.scoped, Effect.provide(world({ runtimes: [runtime], repos: ["demo"] })));
  });

  it.live("a released failed resume can fall back without reserving its old allocation", () => {
    let opens = 0;
    const base = worker([]);
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        const number = ++opens;
        const session = await base.session(...args);
        return {
          ...session,
          prompt: async (...input: Parameters<typeof session.prompt>) => {
            const outcome = await session.prompt(...input);
            if (number === 2) throw new Error("resume transport dropped");
            return outcome;
          },
        };
      },
    };
    return Effect.gen(function* () {
      const sessions = yield* Sessions;
      const core = yield* Core;
      yield* (yield* Agents).saveAgent(lab());
      const sent = yield* sessions.send(lab(), "first run", "demo", { issue: { id: "i1", number: 1 }, worktree: true });
      const id = sent.session!.id;
      yield* until(() => phase(core, id) === "done", "the initial report");
      yield* Effect.flip(sessions.handOver(id, "merged", () => Effect.fail(MergeFailure.check("fix next time"))));
      expect((yield* sessions.deliver(id, "resume the work", { kind: "comment" })).kind).toBe("run");
      yield* until(() => phase(core, id) === "done" && core.session(id)?.lastRun?.summary === "做完了第 3 轮", "the fallback report");
      expect(opens).toBe(3);
      expect(sessions.noRoom("pi", "demo")).toBe("");
      expect((yield* sessions.list("lab")).map((s) => s.id)).toEqual([id]);
    }).pipe(
      Effect.scoped,
      Effect.provide(world({ config: { ...testConfig(), project: { maxSessions: 1, checkTimeoutSeconds: 60 } }, runtimes: [runtime], repos: ["demo"] })),
    );
  });

  it.live("a failed resume that cannot stop never falls back to a second writer", () => {
    let opens = 0;
    let turns = 0;
    let wrote = () => {};
    const written = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    const cleanups: (() => Promise<void>)[] = [];
    const base = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        turns++;
        if (turns === 1) return turn.say("结论：等下一轮");
        writeFileSync(join(turn.options.cwd, `owned-${turns}.txt`), "the failed resume owns this worktree\n");
        wrote();
        await new Promise<void>((resolve) => turn.signal.addEventListener("abort", () => resolve()));
      },
    });
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        const session = await base.session(...args);
        const broken = ++opens > 1;
        cleanups.push(async () => {
          await session.dispose();
        });
        return {
          ...session,
          prompt: async (...input: Parameters<typeof session.prompt>) => {
            const outcome = await session.prompt(...input);
            if (!broken) return outcome;
            await written;
            throw new Error("resume transport dropped");
          },
          dispose: async () => {
            if (broken) throw new Error("did not stop");
            await session.dispose();
          },
        };
      },
    };
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          for (const cleanup of cleanups) await cleanup();
        }),
      );
      const sessions = yield* Sessions;
      const core = yield* Core;
      yield* (yield* Agents).saveAgent(lab());
      const sent = yield* sessions.send(lab(), "first run", "demo", { issue: { id: "i1", number: 1 }, worktree: true });
      const id = sent.session!.id;
      yield* until(() => phase(core, id) === "done", "the initial report");
      yield* Effect.flip(sessions.handOver(id, "merged", () => Effect.fail(MergeFailure.check("fix next time"))));
      const resumed = yield* sessions.deliver(id, "resume the work", { kind: "comment" });
      expect(resumed.kind).toBe("refused");
      expect(JSON.stringify(resumed)).toContain("did not stop");
      expect(opens).toBe(2);
      expect(sessions.noRoom("pi", "demo")).not.toBe("");
      expect((yield* sessions.deliver(id, "do not start again", { kind: "comment" })).kind).toBe("refused");
      expect(opens).toBe(2);
    }).pipe(
      Effect.scoped,
      Effect.provide(world({ config: { ...testConfig(), project: { maxSessions: 1, checkTimeoutSeconds: 60 } }, runtimes: [runtime], repos: ["demo"] })),
    );
  });

  it.live("handover never uses a workplace whose runtime failed to close", () => {
    let cleanup = async () => {};
    let used = false;
    let closes = 0;
    const base = worker([]);
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        const session = await base.session(...args);
        cleanup = async () => {
          await session.dispose();
        };
        return {
          ...session,
          dispose: async () => {
            closes++;
            throw new Error("did not stop");
          },
        };
      },
    };
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.promise(() => cleanup()));
      const sessions = yield* Sessions;
      const core = yield* Core;
      const sent = yield* sessions.send(lab(), "work", "demo", { issue: { id: "i1", number: 1 }, worktree: true });
      const id = sent.session!.id;
      yield* until(() => phase(core, id) === "done", "the report");
      const before = sessions.find(id)!;
      for (let n = 0; n < 2; n++) {
        const result = yield* Effect.result(
          sessions.handOver(id, "merged", () =>
            Effect.sync(() => {
              used = true;
              return { text: "", commits: 1 };
            }),
          ),
        );
        expect(result._tag).toBe("Failure");
        expect(JSON.stringify(result)).toContain("did not stop");
        expect(sessions.find(id)?.lastText).toBe(before.lastText);
        expect(existsSync(before.place.cwd)).toBe(true);
      }
      expect(used).toBe(false);
      expect(closes).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(world({ runtimes: [runtime], repos: ["demo"] })));
  });

  it.live("a session is sent, works its run, reports, takes a word and is merged", () => {
    const turns: ScriptedTurn[] = [];
    return Effect.gen(function* () {
      const sessions = yield* Sessions;
      const core = yield* Core;
      const seen: LaunchActivity[] = [];
      const following = yield* Effect.forkScoped(Stream.runForEach(yield* sessions.launches, (a) => Effect.sync(() => seen.push(a))));
      yield* Effect.sleep(5);

      const hired = yield* sessions.send(lab(), "给打卡接口加分页", "demo", { issue: { id: "i1", number: 1 }, worktree: true });
      const id = hired.session!.id;
      expect(id).toBe("w1");
      yield* until(() => phase(core, id) === "done", "the first run's report");
      const session = core.session(id)!;
      expect([session.lastRun?.outcome, session.lastRun?.summary, session.runs]).toEqual(["completed", "做完了第 1 轮", 1]);
      expect(turns[0]!.options.mcpServers?.[0]).toMatchObject({ name: "vibevalley", type: "http" });
      expect(sessions.who(((turns[0]!.options.mcpServers![0] as { headers: Record<string, string> }).headers.authorization ?? "").replace("Bearer ", ""))).toBe(
        id,
      );
      expect(turns[0]!.input).toContain("给打卡接口加分页");
      expect(turns[0]!.options.cwd).toBe((sessions as SessionsInside).place(id)!.cwd);

      const events = sessions.events(id)!;
      expect(events.map((e) => e.type)).toEqual(
        expect.arrayContaining(["run/start", "user/message", "tool/call", "tool/result", "assistant/message", "run/end"]),
      );
      // The run's end is written just after the report's fact.
      let runs = yield* sessions.runs("i1");
      for (let i = 0; i < 100 && runs[0]?.outcome === undefined; i++) {
        yield* Effect.sleep(10);
        runs = yield* sessions.runs("i1");
      }
      expect(runs.map((r) => [r.triggeredBy.kind, r.outcome])).toEqual([["issue", "completed"]]);
      expect((sessions as SessionsInside).currentRun(id)).toBe("");

      const told = yield* sessions.tell(id, "再加个测试", { kind: "comment", message: "m1" });
      expect(told).toBe("老实人 开始新的一轮".replace("老实人", session.name));
      yield* until(() => core.session(id)?.runs === 2 && phase(core, id) === "done", "the second run");
      expect((yield* sessions.runs("i1")).map((r) => r.triggeredBy.kind)).toEqual(["issue", "comment"]);
      expect(seen.some((a) => a.kind === "ended" && a.id === id)).toBe(true);

      const projects = yield* Projects;
      const merged = yield* sessions.handOver(id, "merged", (place) => projects.merge(place));
      expect(merged.commits).toBe(2);
      expect(core.session(id)).toBeUndefined();
      const gone = (yield* sessions.get(id))!;
      expect([gone.phase, gone.runs, gone.lastRun?.outcome]).toMatchObject([{ _tag: "closed", closed: "merged" }, 2, "completed"]);
      expect((yield* sessions.list("lab")).map((s) => s.id)).toEqual([id]);
      expect(sessions.who("nothing")).toBe("");
      yield* Fiber.interrupt(following);
    }).pipe(Effect.scoped, Effect.provide(world({ runtimes: [worker(turns)], repos: ["demo"] })));
  });

  it.live("a turn asked for holds its room until it is working", () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const core = yield* Core;
      const s = sessions as SessionsInside;
      yield* core.apply({
        type: "hired",
        session: { id: "w1", name: "w1", agent: "lab", runtime: "pi", brief: "", project: "demo", hiredAt: 0, runs: 0, phase: { _tag: "done" } } as Session,
      });
      const h: Parameters<typeof s.expect>[0] = {
        id: "w1",
        place: { project: "demo", cwd: "/nowhere" },
        access: Semaphore.makeUnsafe(1),
        journal: s.trajectories.openLog("w1"),
        oarSessionId: "",
        lastText: "",
        tracking: {},
        launch: "",
        spoke: false,
        recalled: new Set(),
        triggers: [],
        run: "",
        heard: [],
      };
      s.hands.set("w1", h);
      s.expect(h, { kind: "comment" });
      expect(sessions.noRoom("pi", "demo")).not.toBe("");
      expect(phase(core, "w1")).toBe("done");
      expect((yield* Effect.flip(sessions.handOver("w1", "merged", () => Effect.succeed({ text: "", commits: 0 })))) as { _tag: string }).toMatchObject({
        _tag: "Refused",
      });
      for (const step of ["pending", "started"]) {
        if (step === "started") {
          yield* core.apply({ type: "run", id: "w1" });
          s.unexpect(h);
        }
        const got = yield* sessions.send(lab(), "another", "demo", { issue: { id: "i2", number: 2 } });
        expect([got.session, got.refused !== undefined, s.hired()]).toEqual([undefined, true, 0]);
      }
      yield* core.apply({ type: "report", id: "w1", outcome: "completed", summary: "", runs: 1 });
      expect(sessions.noRoom("pi", "demo")).toBe("");
    }).pipe(Effect.scoped, Effect.provide(world({ config: { ...testConfig(), project: { maxSessions: 1, checkTimeoutSeconds: 60 } }, repos: ["demo"] }))),
  );
});
