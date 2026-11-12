import { existsSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Session as RuntimeSession } from "@botiverse/oar";
import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, orchestratorRuntime } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";
import { issueId } from "@vibevalley/protocol/schema";
import { tempDir } from "@vibevalley/testkit/temp";

import { messageOf } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import { causeMessage, SqlError } from "#/infra/db.ts";
import { wallTime } from "#/infra/time.ts";
import { watchStalls } from "#/modules/machine/executor.ts";
import { MergeFailure } from "#/modules/repo/workplace.ts";
import { gitIn } from "#/testing/git.ts";
import { starter, testConfig, until, waitFor } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";

import { DeliveryRefused, HireRefused, NotRecorded } from "./session.ts";
import type { SessionNews, DeliveryInput } from "./signals.ts";
import type { WorkerAccess } from "./worker.ts";
const lab = (): T.Agent => ({ ...starter("lab"), effort: "" });
const delivery = (trigger: T.RunTrigger, envelopeIds: readonly string[] = []): DeliveryInput => ({ trigger, envelopeIds, byUserComment: false });

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

const phase = (core: Core, id: string) => core.session(id)?.phase._tag;

/** A worker CLI that is always there and lets every credential in, unless prepare says otherwise. */
const access = (
  prepare: (id: string, endpoint: string, token: string) => Promise<{ readonly authenticated: boolean; readonly command: string }>,
  revoke: (id: string) => Promise<void> = async () => {},
): (() => Promise<WorkerAccess>) => {
  return async () => ({
    command: "worker",
    executableAvailable: async () => true,
    prepare,
    revoke,
    close: async () => {},
    [Symbol.asyncDispose]: async () => {},
  });
};

const failure = <A>(p: Promise<A>) =>
  p.then(
    () => {
      throw new Error("it did not fail");
    },
    (e: unknown) => e,
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("sessions", () => {
  test("interrupting an opening disposes the late session and releases its allocation", async () => {
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
    await using farm = await world({ config: testConfig(), runtimes: [runtime], repos: ["demo"] });
    const sessions = farm.session;
    await farm.agent.save(lab());
    const interrupt = new AbortController();
    const sending = sessions.hire(
      lab(),
      "interrupted",
      "demo",
      { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } }, worktree: true },
      interrupt.signal,
    );
    await opening;
    interrupt.abort();
    release();
    await sending.catch(() => undefined);
    expect(disposed).toBe(1);
    expect(sessions.noRoom("pi", "demo")).toBe("");
    const again = await sessions.hire(lab(), "again", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } }, worktree: true });
    expect(again.session).toBeDefined();
  });

  test("a released failed resume can fall back without reserving its old allocation", async () => {
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
    await using farm = await world({ config: { ...testConfig(), repo: { maxSessions: 1, checkTimeoutSeconds: 60 } }, runtimes: [runtime], repos: ["demo"] });
    const sessions = farm.session;
    const core = farm.core;
    await farm.agent.save(lab());
    const sent = await sessions.hire(lab(), "first run", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } }, worktree: true });
    const id = sent.session.id;
    await until(() => phase(core, id) === "done", "the initial report");
    await failure(
      sessions.handOver(id, "merged", async () => {
        throw MergeFailure.failedCheck("fix next time");
      }),
    );
    expect((await sessions.deliver(id, "resume the work", delivery({ kind: "comment" }))).kind).toBe("run");
    await until(() => phase(core, id) === "done" && core.session(id)?.lastRun?.summary === "做完了第 3 轮", "the fallback report");
    expect(opens).toBe(3);
    expect(sessions.noRoom("pi", "demo")).toBe("");
    expect((await sessions.list("lab")).map((s) => s.id)).toEqual([id]);
  });

  test("a failed resume that cannot stop never falls back to a second writer", async () => {
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
    await using farm = await world({ config: { ...testConfig(), repo: { maxSessions: 1, checkTimeoutSeconds: 60 } }, runtimes: [runtime], repos: ["demo"] });
    try {
      const sessions = farm.session;
      const core = farm.core;
      await farm.agent.save(lab());
      const sent = await sessions.hire(lab(), "first run", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } }, worktree: true });
      const id = sent.session.id;
      await until(() => phase(core, id) === "done", "the initial report");
      await failure(
        sessions.handOver(id, "merged", async () => {
          throw MergeFailure.failedCheck("fix next time");
        }),
      );
      const resumed = await failure(sessions.deliver(id, "resume the work", delivery({ kind: "comment" })));
      expect(resumed).toBeInstanceOf(DeliveryRefused);
      expect(resumed).toMatchObject({ reason: expect.stringContaining("did not stop") });
      expect(opens).toBe(2);
      expect(sessions.noRoom("pi", "demo")).not.toBe("");
      expect(await failure(sessions.deliver(id, "do not start again", delivery({ kind: "comment" })))).toBeInstanceOf(DeliveryRefused);
      expect(opens).toBe(2);
    } finally {
      await Promise.all(cleanups.map((cleanup) => cleanup()));
    }
  });

  test("handover never uses a workplace whose runtime failed to close", async () => {
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
    await using farm = await world({ runtimes: [runtime], repos: ["demo"] });
    try {
      const sessions = farm.session;
      const core = farm.core;
      const sent = await sessions.hire(lab(), "work", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } }, worktree: true });
      const id = sent.session.id;
      await until(() => phase(core, id) === "done", "the report");
      const before = { lastText: sessions.lastTextOf(id), cwd: sessions.cwdOf(id)! };
      for (let n = 0; n < 2; n++) {
        const result = await failure(
          sessions.handOver(id, "merged", async () => {
            used = true;
            return { text: "", commits: 1 };
          }),
        );
        expect(result).toBeInstanceOf(Error);
        expect(messageOf(result)).toContain("did not stop");
        expect(sessions.lastTextOf(id)).toBe(before.lastText);
        expect(existsSync(before.cwd)).toBe(true);
      }
      expect(used).toBe(false);
      expect(closes).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("a session is sent, works its run, reports, takes a word and is merged", async () => {
    const turns: ScriptedTurn[] = [];
    await using farm = await world({ runtimes: [worker(turns)], repos: ["demo"] });
    const sessions = farm.session;
    const core = farm.core;
    const seen: SessionNews[] = [];
    const news = sessions.news();
    const following = (async () => {
      for await (const a of news) seen.push(a);
    })();

    const hired = await sessions.hire(lab(), "给打卡接口加分页", "demo", {
      context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } },
      worktree: true,
    });
    const id = hired.session.id;
    expect(id).toBe("w1");
    await until(() => phase(core, id) === "done", "the first run's report");
    const session = core.session(id)!;
    expect([session.lastRun?.outcome, session.lastRun?.summary, session.runs]).toEqual(["completed", "做完了第 1 轮", 1]);
    expect(turns[0]!.options.mcpServers?.[0]).toMatchObject({ name: "vibevalley", type: "http" });
    expect(sessions.who(((turns[0]!.options.mcpServers![0] as { headers: Record<string, string> }).headers.authorization ?? "").replace("Bearer ", ""))).toBe(
      id,
    );
    expect(turns[0]!.input).toContain("给打卡接口加分页");
    expect(turns[0]!.options.cwd).toBe(sessions.cwdOf(id));

    const events = (await sessions.events(id)) ?? [];
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["run/start", "user/message", "tool/call", "tool/result", "assistant/message", "run/end"]),
    );
    // The run's end is written just after the report's fact.
    const runs = await waitFor(
      () => sessions.issueRuns("i1"),
      (rs) => rs[0]?.outcome !== undefined,
      "the run's end written",
    );
    expect(runs.map((r) => [r.triggeredBy.kind, r.outcome])).toEqual([["issue", "completed"]]);
    expect(sessions.runOf(id)).toBeUndefined();

    const told = await sessions.deliver(id, "再加个测试", delivery({ kind: "comment", message: "m1" }, ["m1"]));
    expect(told).toMatchObject({ kind: "run" });
    await until(() => core.session(id)?.runs === 2 && phase(core, id) === "done", "the second run");
    const both = await waitFor(
      () => sessions.issueRuns("i1"),
      (rs) => rs.length === 2,
      "both runs of the issue",
    );
    expect(both.map((r) => r.triggeredBy.kind)).toEqual(["issue", "comment"]);
    expect(seen.some((a) => a._tag === "HandedOff" && a.id === id)).toBe(true);

    const repos = farm.repo;
    const merged = await sessions.handOver(id, "merged", (place) => repos.merge(place));
    expect(merged.commits).toBe(2);
    expect(core.session(id)).toBeUndefined();
    const gone = (await sessions.get(id))!;
    expect([gone.phase, gone.runs, gone.lastRun?.outcome]).toMatchObject([{ _tag: "closed", closed: "merged" }, 2, "completed"]);
    expect((await sessions.list("lab")).map((s) => s.id)).toEqual([id]);
    expect(sessions.who("nothing")).toBe("");
    news.close();
    await following;
  });

  test("a turn asked for holds its room until it is working", async () => {
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
    await using farm = await world({ config: { ...testConfig(), repo: { maxSessions: 1, checkTimeoutSeconds: 60 } }, runtimes: [runtime], repos: ["demo"] });
    try {
      const sessions = farm.session;
      const core = farm.core;
      const sent = await sessions.hire(lab(), "first", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } } });
      const id = sent.session.id;
      await until(() => phase(core, id) === "done", "the initial report");
      expect((await sessions.deliver(id, "second", delivery({ kind: "comment" }))).kind).toBe("run");
      expect(sessions.noRoom("pi", "demo")).not.toBe("");
      expect(phase(core, id)).toBe("done");
      const handOverFailure = await failure(sessions.handOver(id, "merged", async () => ({ text: "", commits: 0 })));
      expect(handOverFailure).toMatchObject({ name: "ApiError", bizCode: BizCode.SessionRefused });
      for (const step of ["pending", "started"]) {
        if (step === "started") {
          holding = false;
          for (const deliver of pending.splice(0)) deliver();
          await until(() => phase(core, id) === "working", "the buffered turn started");
        }
        const got = await failure(sessions.hire(lab(), "another", "demo", { context: { kind: "issue", issue: { id: issueId("i2"), number: 2 } } }));
        expect([got instanceof HireRefused, got instanceof HireRefused && got.reason !== "", opens]).toEqual([true, true, 1]);
      }
      complete();
      await until(() => phase(core, id) === "done", "the second report");
      expect(sessions.noRoom("pi", "demo")).toBe("");
    } finally {
      complete();
    }
  });

  test("stall sleeping and the quiet timestamp use the same clock", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
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
    const waits: ((signal: AbortSignal) => Promise<void>)[] = [];
    const seen: { silentForMs: number; at: number }[] = [];
    watchStalls(
      session,
      50,
      (silentForMs, at) => seen.push({ silentForMs, at }),
      (wait) => waits.push(wait),
      wallTime,
    );
    emit();
    expect(waits).toHaveLength(1);
    const waiting = waits[0]!(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(49);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([{ silentForMs: 50, at: 50 }]);
    await waiting;
  });

  test("a registration SQL failure is refused rather than hidden as a defect", async () => {
    const config = testConfig();
    await using farm = await world({ config, runtimes: [worker([])], repos: ["demo"] });
    const sessions = farm.session;
    const got = await failure(
      sessions.hire(lab(), "another", "demo", {
        context: { kind: "issue", issue: { id: issueId("i2"), number: 2 } },
        hiring: async () => {
          try {
            await farm.db.sql.query("select no_such_column from issue_assignment");
          } catch (cause) {
            if (cause instanceof SqlError) throw new NotRecorded(causeMessage(cause), { cause });
            throw cause;
          }
        },
      }),
    );
    expect(got).toBeInstanceOf(HireRefused);
    expect(got).toMatchObject({ reason: expect.stringContaining("工单没记下来") });
  });

  test("a non-SQL registration defect is rethrown after the opened session is stopped", async () => {
    const config = testConfig();
    await using farm = await world({ config, runtimes: [worker([])], repos: ["demo"] });
    const sessions = farm.session;
    const got = await failure(
      sessions.hire(lab(), "another", "demo", {
        context: { kind: "issue", issue: { id: issueId("i2"), number: 2 } },
        hiring: async () => {
          throw new Error("registration bug");
        },
      }),
    );
    expect(got).not.toBeInstanceOf(HireRefused);
    expect(got).toMatchObject({ message: "registration bug" });
    const next = await sessions.hire(lab(), "another", "demo", { context: { kind: "issue", issue: { id: issueId("i3"), number: 3 } } });
    expect(next.session).toBeDefined();
  });

  test("regression: a registration defect with failed disposal reports once and retains capacity", async () => {
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
    await using farm = await world({ config: { ...testConfig(), repo: { maxSessions: 1, checkTimeoutSeconds: 60 } }, runtimes: [runtime], repos: ["demo"] });
    try {
      const sessions = farm.session;
      const core = farm.core;
      using events = core.subscribe();
      const got = await failure(
        sessions.hire(lab(), "work", "demo", {
          context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } },
          hiring: async () => {
            throw new Error("registration bug");
          },
        }),
      );
      expect(got).not.toBeInstanceOf(HireRefused);
      expect(got).toMatchObject({ message: "registration bug" });
      core.notice("info", "barrier");
      const all = events.drain();
      const seen = all.slice(
        0,
        all.findIndex((e) => e.type === "notice" && e.text === "barrier"),
      );
      const errors = seen.filter((e) => e.type === "notice" && e.level === "error");
      expect(errors).toHaveLength(1);
      expect(JSON.stringify(errors)).toContain("did not stop");
      expect(closes).toBe(1);
      expect(sessions.noRoom("pi", "demo")).not.toBe("");
      expect(sessions.hired()).toEqual([]);
      const next = await failure(sessions.hire(lab(), "again", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } } }));
      expect(next).toBeInstanceOf(HireRefused);
      expect(next).toMatchObject({ name: "HireRefused", retainedWork: true });
    } finally {
      await cleanup();
    }
  });
});

test("regression: failed CLI authentication revokes the credential and starts no worker", async () => {
  let started = 0;
  let token = "";
  let revoked = 0;
  const runtime = scriptedRuntime({
    id: "pi",
    turn: async (turn) => {
      started++;
      turn.say("unexpected");
    },
  });
  await using farm = await world({
    runtimes: [runtime],
    repos: ["demo"],
    workerAccess: access(
      async (_id, _endpoint, credential) => {
        token = credential;
        return { authenticated: false, command: "worker" };
      },
      async () => {
        revoked++;
      },
    ),
  });
  const sessions = farm.session;
  const hired = await failure(sessions.hire(lab(), "work", "demo", { context: { kind: "issue", issue: { id: issueId("probe"), number: 1 } }, worktree: true }));
  expect(hired).toBeInstanceOf(HireRefused);
  expect(hired).toMatchObject({ reason: expect.stringContaining("认证请求失败") });
  expect(started).toBe(0);
  expect(token).not.toBe("");
  expect(sessions.who(token)).toBe("");
  expect(revoked).toBeGreaterThan(0);
});

test("regression: session service shutdown revokes issued credentials", async () => {
  let token = "";
  const runtime = scriptedRuntime({
    id: "pi",
    turn: async (turn) => {
      turn.say("ready");
    },
  });
  let who: (token: string) => string = () => "unread";
  {
    await using farm = await world({
      runtimes: [runtime],
      repos: ["demo"],
      workerAccess: access(async (_id, _endpoint, credential) => {
        token = credential;
        return { authenticated: true, command: "worker" };
      }),
    });
    const sessions = farm.session;
    const result = await sessions.hire(lab(), "work", "demo", { context: { kind: "issue", issue: { id: issueId("scope"), number: 1 } }, worktree: true });
    expect(result.session).toBeDefined();
    expect(sessions.who(token)).not.toBe("");
    who = sessions.who;
  }
  expect(who(token)).toBe("");
});

for (const mode of ["refused", "failed", "interrupted"] as const) {
  test(`regression: worker credentials are revoked when executor startup is ${mode}`, async () => {
    let token = "";
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const base = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        turn.say("unexpected");
      },
    });
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        entered.resolve();
        if (mode === "failed") throw new Error("startup failed");
        await released.promise;
        return base.session(...args);
      },
    };
    const file = join(tempDir("vibevalley-access-"), "access.json");
    await using farm = await world({
      workerAccess: access(
        async (_id, _endpoint, credential) => {
          token = credential;
          await writeFile(file, credential, { mode: 0o600 });
          return { authenticated: true, command: "worker" };
        },
        () => rm(file, { force: true }),
      ),
      runtimes: [runtime],
      repos: ["demo"],
    });
    const sessions = farm.session;
    const agent = { ...starter("lab"), effort: "", runtime: mode === "refused" ? "missing" : "pi" };
    const interrupt = new AbortController();
    const send = sessions.hire(
      agent,
      "work",
      "demo",
      { context: { kind: "issue", issue: { id: issueId("probe"), number: 1 } }, worktree: true },
      interrupt.signal,
    );
    if (mode === "interrupted") {
      await entered.promise;
      interrupt.abort();
      released.resolve();
      await send.catch(() => undefined);
    } else {
      const result = await failure(send);
      expect(result).toBeInstanceOf(HireRefused);
      expect(result).toMatchObject({ reason: expect.not.stringMatching(/^$/u) });
    }
    expect(token).not.toBe("");
    expect(sessions.who(token)).toBe("");
    expect(existsSync(file)).toBe(false);
  });
}

test("regression: reopening a session rotates its credential before delivering the next turn", async () => {
  const tokens: string[] = [];
  const runtime = scriptedRuntime({
    id: "pi",
    turn: async (turn) => {
      turn.say("ready");
    },
  });
  await using farm = await world({
    runtimes: [runtime],
    repos: ["demo"],
    workerAccess: access(async (_id, _endpoint, token) => {
      tokens.push(token);
      return { authenticated: true, command: "worker" };
    }),
  });
  const sessions = farm.session;
  await farm.agent.save(lab());
  const result = await sessions.hire(lab(), "work", "demo", { context: { kind: "issue", issue: { id: issueId("rotation"), number: 1 } }, worktree: true });
  const id = result.session.id;
  await until(() => sessions.sessionOf(id)?.phase._tag !== "working", "first turn ended");
  const suspend2 = await sessions.suspend(id);
  expect(suspend2).toBe(true);
  expect((await sessions.deliver(id, "again", { trigger: { kind: "comment" }, envelopeIds: [], byUserComment: true })).kind).toBe("run");
  expect(tokens.length).toBe(2);
  expect(tokens[1] !== tokens[0]).toBe(true);
  expect(sessions.who(tokens[0]!)).toBe("");
  expect(sessions.who(tokens[1]!)).toBe(id);
});

describe("orchestrator profiles", () => {
  test("regression: an orchestrator profile has its session as soon as it is kept, and its new name as soon as it is renamed", async () => {
    await using farm = await world({ runtimes: [], repos: [] });
    const agents = farm.agent;
    const sessions = farm.session;
    const lead = await agents.create({ ...starter(defaultOrchestrator), id: "", name: "前端组长", role: "orchestrator", runtime: orchestratorRuntime });
    expect(sessions.sessionOf(lead.id)?.name).toBe("前端组长");
    await agents.save({ ...lead, name: "前端总管" });
    expect(sessions.sessionOf(lead.id)?.name).toBe("前端总管");
  }, 30_000);
});
