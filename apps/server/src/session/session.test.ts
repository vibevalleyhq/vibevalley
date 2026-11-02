import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Session as RuntimeSession } from "@botiverse/oar";
import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Clock, Effect, Exit, Fiber, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import type * as T from "@vibevalley/protocol";
import { issueId } from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import type { LaunchActivity } from "@/channel/chat.ts";
import { Core } from "@/core/core.ts";
import { watchStalls } from "@/executor/executor.ts";
import { Project } from "@/project/project.ts";
import { MergeFailure } from "@/project/shapes.ts";
import { gitIn } from "@/testing/git.ts";
import { starter, testConfig } from "@/testing/layers.ts";
import { until, waitFor } from "@/testing/until.ts";
import { world } from "@/testing/world.ts";

import { NotRecorded, Session } from "./session.ts";
import type { DeliveryInput } from "./shapes.ts";
const lab = (): T.Agent => ({ ...starter("lab"), effort: "" });
const delivery = (trigger: T.RunTrigger, envelopeIds: readonly string[] = []): DeliveryInput => ({ trigger, envelopeIds, byOwnerComment: false });

/** A helper that writes a file, commits it and reports, as the farm's rules ask. */
const worker = (turns: ScriptedTurn[]) =>
  scriptedRuntime({
    id: "pi",
    turn: async (turn) => {
      turns.push(turn);
      await turn.tool("bash", JSON.stringify({ command: `cd ${turn.options.cwd} && touch done.txt` }), () => {
        writeFileSync(join(turn.options.cwd, `done-${turns.length}.txt`), "done\n");
        gitIn(turn.options.cwd, "-c", "user.name=w", "-c", "user.email=w@x", "add", "-A");
        gitIn(turn.options.cwd, "-c", "user.name=w", "-c", "user.email=w@x", "commit", "-qm", `做完第 ${turns.length} 轮`);
        return "ok";
      });
      turn.say(`做完了第 ${turns.length} 轮`);
    },
  });

const phase = (core: Core["Service"], id: string) => core.session(id)?.phase._tag;

describe("sessions", () => {
  it.live("interrupting an opening disposes the late session and releases its allocation", () => {
    const { promise: opening, resolve: entered } = Promise.withResolvers<void>();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    let disposed = 0;
    const base = worker([]);
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        entered();
        await gate;
        const session = await base.session(...args);
        return {
          ...session,
          dispose: async () => {
            disposed++;
            await session.dispose();
          },
        };
      },
    };
    return Effect.gen(function* () {
      const sessions = yield* Session;
      yield* (yield* Agent).save(lab());
      const sending = yield* Effect.forkChild(
        sessions.send(lab(), "interrupted", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } }, worktree: true }),
      );
      yield* Effect.promise(() => opening);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(sending));
      yield* Effect.yieldNow;
      release();
      yield* Fiber.join(interrupting);
      expect(disposed).toBe(1);
      expect(sessions.noRoom("pi", "demo")).toBe("");
      const again = yield* sessions.send(lab(), "again", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } }, worktree: true });
      expect(again.session).toBeDefined();
      expect(again.refused).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(world({ config: testConfig(), runtimes: [runtime], repos: ["demo"] })));
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
      const sessions = yield* Session;
      const core = yield* Core;
      yield* (yield* Agent).save(lab());
      const sent = yield* sessions.send(lab(), "first run", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } }, worktree: true });
      const id = sent.session!.id;
      yield* until(() => phase(core, id) === "done", "the initial report");
      yield* Effect.flip(sessions.handOver(id, "merged", () => Effect.fail(MergeFailure.failedCheck("fix next time"))));
      expect((yield* sessions.deliver(id, "resume the work", delivery({ kind: "comment" }))).kind).toBe("run");
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
    const { promise: written, resolve: wrote } = Promise.withResolvers<void>();
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
          await Promise.all(cleanups.map((cleanup) => cleanup()));
        }),
      );
      const sessions = yield* Session;
      const core = yield* Core;
      yield* (yield* Agent).save(lab());
      const sent = yield* sessions.send(lab(), "first run", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } }, worktree: true });
      const id = sent.session!.id;
      yield* until(() => phase(core, id) === "done", "the initial report");
      yield* Effect.flip(sessions.handOver(id, "merged", () => Effect.fail(MergeFailure.failedCheck("fix next time"))));
      const resumed = yield* sessions.deliver(id, "resume the work", delivery({ kind: "comment" }));
      expect(resumed.kind).toBe("refused");
      expect(JSON.stringify(resumed)).toContain("did not stop");
      expect(opens).toBe(2);
      expect(sessions.noRoom("pi", "demo")).not.toBe("");
      expect((yield* sessions.deliver(id, "do not start again", delivery({ kind: "comment" }))).kind).toBe("refused");
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
      const sessions = yield* Session;
      const core = yield* Core;
      const sent = yield* sessions.send(lab(), "work", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } }, worktree: true });
      const id = sent.session!.id;
      yield* until(() => phase(core, id) === "done", "the report");
      const before = { lastText: sessions.lastTextOf(id), cwd: sessions.cwdOf(id)! };
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
        expect(sessions.lastTextOf(id)).toBe(before.lastText);
        expect(existsSync(before.cwd)).toBe(true);
      }
      expect(used).toBe(false);
      expect(closes).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(world({ runtimes: [runtime], repos: ["demo"] })));
  });

  it.live("a session is sent, works its run, reports, takes a word and is merged", () => {
    const turns: ScriptedTurn[] = [];
    return Effect.gen(function* () {
      const sessions = yield* Session;
      const core = yield* Core;
      const seen: LaunchActivity[] = [];
      const following = yield* Effect.forkScoped(Stream.runForEach(yield* sessions.launches, (a) => Effect.sync(() => seen.push(a))));

      const hired = yield* sessions.send(lab(), "给打卡接口加分页", "demo", {
        context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } },
        worktree: true,
      });
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
      expect(turns[0]!.options.cwd).toBe(sessions.cwdOf(id));

      const events = (yield* sessions.events(id)) ?? [];
      expect(events.map((e) => e.type)).toEqual(
        expect.arrayContaining(["run/start", "user/message", "tool/call", "tool/result", "assistant/message", "run/end"]),
      );
      // The run's end is written just after the report's fact.
      const runs = yield* waitFor(sessions.issueRuns("i1"), (rs) => rs[0]?.outcome !== undefined, "the run's end written");
      expect(runs.map((r) => [r.triggeredBy.kind, r.outcome])).toEqual([["issue", "completed"]]);
      expect(sessions.runOf(id)).toBeUndefined();

      const told = yield* sessions.deliver(id, "再加个测试", delivery({ kind: "comment", message: "m1" }, ["m1"]));
      expect(told).toMatchObject({ kind: "run" });
      yield* until(() => core.session(id)?.runs === 2 && phase(core, id) === "done", "the second run");
      const both = yield* waitFor(sessions.issueRuns("i1"), (rs) => rs.length === 2, "both runs of the issue");
      expect(both.map((r) => r.triggeredBy.kind)).toEqual(["issue", "comment"]);
      expect(seen.some((a) => a.kind === "handedOff" && a.id === id)).toBe(true);

      const projects = yield* Project;
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

  it.live("a turn asked for holds its room until it is working", () => {
    const { promise: finish, resolve: complete } = Promise.withResolvers<void>();
    let opens = 0;
    let holding = false;
    const pending: (() => void)[] = [];
    const base = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        if (turn.input === "second") await finish;
        turn.say("done");
      },
    });
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        opens++;
        const session = await base.session(...args);
        return {
          ...session,
          prompt: (input: string, options?: Parameters<RuntimeSession["prompt"]>[1]) => {
            if (input === "second") holding = true;
            return session.prompt(input, options);
          },
          events: (observer: Parameters<RuntimeSession["events"]>[0], options?: Parameters<RuntimeSession["events"]>[1]) =>
            session.events((event) => {
              if (holding) pending.push(() => observer(event));
              else observer(event);
            }, options),
        };
      },
    };
    return Effect.gen(function* () {
      const sessions = yield* Session;
      const core = yield* Core;
      const sent = yield* sessions.send(lab(), "first", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } } });
      const id = sent.session!.id;
      yield* until(() => phase(core, id) === "done", "the initial report");
      expect((yield* sessions.deliver(id, "second", delivery({ kind: "comment" }))).kind).toBe("run");
      expect(sessions.noRoom("pi", "demo")).not.toBe("");
      expect(phase(core, id)).toBe("done");
      expect(yield* Effect.flip(sessions.handOver(id, "merged", () => Effect.succeed({ text: "", commits: 0 })))).toMatchObject({ _tag: "Refused" });
      for (const step of ["pending", "started"]) {
        if (step === "started") {
          holding = false;
          for (const deliver of pending.splice(0)) deliver();
          yield* until(() => phase(core, id) === "working", "the buffered turn started");
        }
        const got = yield* sessions.send(lab(), "another", "demo", { context: { kind: "issue", issue: { id: issueId("i2"), number: 2 } } });
        expect([got.session, got.refused !== undefined, opens]).toEqual([undefined, true, 1]);
      }
      complete();
      yield* until(() => phase(core, id) === "done", "the second report");
      expect(sessions.noRoom("pi", "demo")).toBe("");
    }).pipe(
      Effect.ensuring(Effect.sync(complete)),
      Effect.scoped,
      Effect.provide(world({ config: { ...testConfig(), project: { maxSessions: 1, checkTimeoutSeconds: 60 } }, runtimes: [runtime], repos: ["demo"] })),
    );
  });

  it.effect("stall sleeping and the quiet timestamp use the same clock", () =>
    Effect.gen(function* () {
      const record = {
        kind: "request",
        id: "r1",
        direction: "toRuntime",
        body: { kind: "prompt", input: "start" },
        sessionId: "w1",
        agentPath: [],
        seq: 0,
        receivedAt: 0,
      } as const;
      let emit = () => {};
      const session = {
        id: "w1",
        rawEvents: (observer: (event: typeof record) => void) => {
          emit = () => observer(record);
          return () => undefined;
        },
      } as unknown as RuntimeSession;
      const clock = yield* Clock.Clock;
      const waits: Effect.Effect<void>[] = [];
      const seen: { silentForMs: number; at: number }[] = [];
      watchStalls(
        session,
        50,
        (silentForMs, at) => seen.push({ silentForMs, at }),
        (wait) => waits.push(wait),
        () => clock.currentTimeMillisUnsafe(),
      );
      emit();
      expect(waits).toHaveLength(1);
      yield* Effect.forkChild(waits[0]);
      yield* TestClock.adjust(49);
      expect(seen).toEqual([]);
      yield* TestClock.adjust(1);
      expect(seen).toEqual([{ silentForMs: 50, at: 50 }]);
    }),
  );

  it.live("a registration SQL failure is refused rather than hidden as a defect", () => {
    const config = testConfig();
    return Effect.gen(function* () {
      const sessions = yield* Session;
      const sql = yield* SqlClient.SqlClient;
      const got = yield* sessions.send(lab(), "another", "demo", {
        context: { kind: "issue", issue: { id: issueId("i2"), number: 2 } },
        hiring: () => Effect.mapError(sql.unsafe("select no_such_column from issue_assignment"), (cause) => new NotRecorded({ message: cause.message, cause })),
      });
      expect(got.refused).toContain("工单没记下来");
    }).pipe(Effect.scoped, Effect.provide(world({ config, runtimes: [worker([])], repos: ["demo"] })));
  });

  it.live("a non-SQL registration defect is rethrown after the opened session is stopped", () => {
    const config = testConfig();
    return Effect.gen(function* () {
      const sessions = yield* Session;
      const exit = yield* Effect.exit(
        sessions.send(lab(), "another", "demo", {
          context: { kind: "issue", issue: { id: issueId("i2"), number: 2 } },
          hiring: () => Effect.die(new Error("registration bug")),
        }),
      );
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      const next = yield* sessions.send(lab(), "another", "demo", { context: { kind: "issue", issue: { id: issueId("i3"), number: 3 } } });
      expect(next.session).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(world({ config, runtimes: [worker([])], repos: ["demo"] })));
  });

  it.live("regression: a registration defect with failed disposal reports once and retains capacity", () => {
    let cleanup = async () => {};
    let closes = 0;
    const base = worker([]);
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        const session = await base.session(...args);
        cleanup = () => session.dispose();
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
      const sessions = yield* Session;
      const core = yield* Core;
      const events = yield* core.subscribe;
      const exit = yield* Effect.exit(
        sessions.send(lab(), "work", "demo", {
          context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } },
          hiring: () => Effect.die(new Error("registration bug")),
        }),
      );
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      yield* core.notice("info", "barrier");
      const seen = yield* events.pipe(
        Stream.takeUntil((e) => e.type === "notice" && e.text === "barrier"),
        Stream.runCollect,
      );
      const errors = seen.filter((e) => e.type === "notice" && e.level === "error");
      expect(errors).toHaveLength(1);
      expect(JSON.stringify(errors)).toContain("did not stop");
      expect(closes).toBe(1);
      expect(sessions.noRoom("pi", "demo")).not.toBe("");
      expect(sessions.presentSessions()).toEqual([]);
      const next = yield* sessions.send(lab(), "again", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } } });
      expect(next).toMatchObject({ retainedWork: true });
      expect(next.session).toBeUndefined();
    }).pipe(
      Effect.scoped,
      Effect.provide(world({ config: { ...testConfig(), project: { maxSessions: 1, checkTimeoutSeconds: 60 } }, runtimes: [runtime], repos: ["demo"] })),
    );
  });
});
