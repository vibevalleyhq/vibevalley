import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { maxRunning } from "@vibevalley/protocol";

import { Agent } from "#/agent/agent.ts";
import { Channel } from "#/channel/channel.ts";
import { Core } from "#/core/core.ts";
import { Executor } from "#/executor/executor.ts";
import { Repo } from "#/repo/repo.ts";
import { starter, testConfig, until, waitFor } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";

import { NotRecorded, Session } from "./session.ts";
import type { DeliveryInput } from "./signals.ts";

const profile = () => ({ ...starter("lab"), effort: "" });
const delivery = (trigger: DeliveryInput["trigger"]): DeliveryInput => ({ trigger, envelopeIds: [], byOwnerComment: false });

describe("an agent's channel context", () => {
  it.live("regression: a channel context resumes without an issue or a repo checkout", () => {
    const config = testConfig();
    const turns: ScriptedTurn[] = [];
    const runtime = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        turns.push(turn);
        writeFileSync(join(turn.options.cwd, "notes.txt"), `turn ${turns.length}\n`);
        turn.say(`结论：回答 ${turns.length}`);
      },
    });
    return Effect.gen(function* () {
      const sessions = yield* Session;
      const executor = yield* Executor;
      const core = yield* Core;
      const repos = yield* Repo;
      const channel = (yield* Channel).defaultChannel();
      const agent = profile();
      yield* (yield* Agent).save(agent);
      const hired = yield* sessions.send(agent, "discuss", "must-not-create", { context: { kind: "channel", channel } });
      const session = hired.session;
      expect(session).toBeDefined();
      if (!session) return;
      yield* until(() => core.session(session.id)?.phase._tag === "done", "the first answer");
      expect(session.issue).toBeUndefined();
      expect(session.repo).toBeUndefined();
      expect(session.channel).toBe(channel);
      expect(core.state().issues).toEqual([]);
      expect(yield* repos.list()).toEqual([]);
      const cwd = turns[0]?.options.cwd ?? "";
      expect(dirname(cwd)).toBe(join(realpathSync(config.workRoot), "contexts"));
      expect(basename(cwd).startsWith(session.id + "-")).toBe(true);
      const native = executor.find(session.id)?.sessionId;
      expect(yield* sessions.suspend(session.id)).toBe(true);
      expect(executor.find(session.id)).toBeUndefined();
      expect(sessions.sessionOf(session.id)?.id).toBe(session.id);
      expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("turn 1\n");
      expect(yield* sessions.deliver(session.id, "continue", delivery({ kind: "comment", channel }))).toMatchObject({ kind: "run", woke: true });
      yield* until(() => core.session(session.id)?.runs === 2, "the continued answer");
      const kept = yield* waitFor(
        Effect.map(sessions.events(session.id), (events) => events ?? []),
        (events) => events.filter((event) => event.type === "run/end").length === 2,
        "the context's run ends",
      );
      const starts = kept.filter((event) => event.type === "run/start");
      const ends = kept.filter((event) => event.type === "run/end");
      expect([starts.length, ends.length, new Set(starts.map((event) => event.run)).size]).toEqual([2, 2, 2]);
      expect(turns[1]?.options.resume).toBe(native);
      expect(turns[1]?.options.cwd).toBe(cwd);
      let merged = false;
      const refused = yield* Effect.flip(
        sessions.handOver(session.id, "merged", () => {
          merged = true;
          return Effect.succeed({ text: "", commits: 0 });
        }),
      );
      expect(refused._tag).toBe("Refused");
      expect(merged).toBe(false);
      expect((yield* Effect.flip(sessions.discardWork(session.id)))._tag).toBe("Refused");
      expect((yield* Effect.flip(sessions.dismiss(session.id, "discard")))._tag).toBe("Refused");
      expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("turn 2\n");
    }).pipe(Effect.scoped, Effect.provide(world({ config, runtimes: [runtime] })));
  });

  it.live("regression: freeing an idle channel execution keeps its session identity", () => {
    const runtime = scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("结论：回答了") });
    return Effect.gen(function* () {
      const sessions = yield* Session;
      const executor = yield* Executor;
      const core = yield* Core;
      const chat = yield* Channel;
      const agent = profile();
      yield* (yield* Agent).save(agent);
      const ids: string[] = [];
      for (let i = 0; i < maxRunning; i++) {
        const channel = (yield* chat.openChannel(`context-${i}`, "", "")).id;
        const hired = yield* sessions.send(agent, "discuss", "", { context: { kind: "channel", channel } });
        const id = hired.session?.id;
        expect(id).toBeDefined();
        if (!id) return;
        ids.push(id);
        yield* until(() => core.session(id)?.phase._tag === "done", "an answer");
      }
      expect(executor.all()).toHaveLength(maxRunning);
      expect(yield* sessions.makeRoom("pi", "")).toHaveProperty("evicted");
      expect(executor.all()).toHaveLength(maxRunning - 1);
      expect(sessions.presentSessions().map((s) => s.id)).toEqual(ids);
      for (const id of ids) yield* sessions.suspend(id);
      expect(yield* sessions.makeRoom("pi", "")).toEqual({});
      expect(sessions.presentSessions()).toHaveLength(maxRunning);
    }).pipe(Effect.scoped, Effect.provide(world({ runtimes: [runtime] })));
  });

  it.live("regression: a failed channel opening removes only its empty context directory", () => {
    const config = testConfig();
    return Effect.gen(function* () {
      const sessions = yield* Session;
      const channel = (yield* Channel).defaultChannel();
      const agent = { ...profile(), runtime: "not-installed" };
      const hired = yield* sessions.send(agent, "discuss", "", { context: { kind: "channel", channel } });
      expect(hired.session).toBeUndefined();
      expect(hired.retainedWork).toBeUndefined();
      expect(readdirSync(join(config.workRoot, "contexts"))).toEqual([]);
      expect(sessions.presentSessions()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(world({ config })));
  });

  it.live("regression: a channel opening whose execution cannot close keeps its files and blocks a second writer", () => {
    const config = testConfig();
    const { promise: written, resolve: wrote } = Promise.withResolvers<void>();
    let opened = 0;
    let cwd = "";
    const base = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        cwd = turn.options.cwd;
        writeFileSync(join(cwd, "kept.txt"), "keep\n");
        wrote();
        turn.say("结论：回答了");
      },
    });
    const runtime = {
      ...base,
      session: (...args: Parameters<typeof base.session>) =>
        base.session(...args).then((session) => {
          opened++;
          return { ...session, dispose: () => session.dispose().then(() => Promise.reject(new Error("disposal not confirmed"))) };
        }),
    };
    return Effect.gen(function* () {
      const sessions = yield* Session;
      const channel = (yield* Channel).defaultChannel();
      const agent = profile();
      yield* (yield* Agent).save(agent);
      const hired = yield* sessions.send(agent, "first", "", {
        context: { kind: "channel", channel },
        hiring: () =>
          Effect.andThen(
            Effect.promise(() => written),
            Effect.fail(new NotRecorded({ message: "registration failed" })),
          ),
      });
      expect(hired.session).toBeUndefined();
      expect(hired.retainedWork).toBe(true);
      expect(readFileSync(join(cwd, "kept.txt"), "utf8")).toBe("keep\n");
      const again = yield* sessions.send(agent, "again", "", { context: { kind: "channel", channel } });
      expect(again.session).toBeUndefined();
      expect(again.retainedWork).toBe(true);
      expect(opened).toBe(1);
      expect(readdirSync(join(config.workRoot, "contexts"))).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(world({ config, runtimes: [runtime] })));
  });

  it.live("regression: a restarted channel context keeps its reply channel and native resume id", () => {
    const base = testConfig();
    const config = { ...base, db: join(base.home, "db") };
    const turns: ScriptedTurn[] = [];
    const runtime = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        turns.push(turn);
        writeFileSync(join(turn.options.cwd, "kept.txt"), "context\n");
        turn.say("结论：回答了");
      },
    });
    let id = "";
    let channel = "";
    let native: string | undefined;
    let cwd = "";
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const sessions = yield* Session;
        const executor = yield* Executor;
        const core = yield* Core;
        const agent = profile();
        yield* (yield* Agent).save(agent);
        channel = (yield* Channel).defaultChannel();
        const hired = yield* sessions.send(agent, "first", "", { context: { kind: "channel", channel } });
        id = hired.session?.id ?? "";
        expect(id).not.toBe("");
        yield* until(() => core.session(id)?.phase._tag === "done", "the answer before restart");
        native = executor.find(id)?.sessionId;
        cwd = sessions.cwdOf(id) ?? "";
        yield* sessions.suspend(id);
      }).pipe(Effect.scoped, Effect.provide(world({ config, runtimes: [runtime] })));
      yield* Effect.gen(function* () {
        const sessions = yield* Session;
        const core = yield* Core;
        yield* sessions.restore;
        expect(sessions.sessionOf(id)?.channel).toBe(channel);
        expect(sessions.sessionOf(id)?.issue).toBeUndefined();
        expect(existsSync(join(cwd, "kept.txt"))).toBe(true);
        expect(yield* sessions.deliver(id, "after restart", delivery({ kind: "comment", channel }))).toMatchObject({ kind: "run", woke: true });
        yield* until(() => core.session(id)?.runs === 2, "the answer after restart");
        expect(turns[1]?.options.resume).toBe(native);
        yield* sessions.dismiss(id);
        expect((yield* sessions.get(id))?.channel).toBe(channel);
      }).pipe(Effect.scoped, Effect.provide(world({ config, runtimes: [runtime] })));
    });
  });

  it.live("regression: an unregistered context retained across restart is never reused by another profile", () => {
    const base = testConfig();
    const config = { ...base, db: join(base.home, "db") };
    const { promise: written, resolve: wrote } = Promise.withResolvers<void>();
    const directories: string[] = [];
    let inherited = false;
    const runtime = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        const cwd = turn.options.cwd;
        directories.push(cwd);
        if (directories.length === 1) {
          writeFileSync(join(cwd, "private.txt"), "first profile\n");
          wrote();
        } else inherited = existsSync(join(cwd, "private.txt"));
        turn.say("结论：回答了");
      },
    });
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const sessions = yield* Session;
        const channel = (yield* Channel).defaultChannel();
        const refused = yield* sessions.send(profile(), "first", "", {
          context: { kind: "channel", channel },
          hiring: () =>
            Effect.andThen(
              Effect.promise(() => written),
              Effect.fail(new NotRecorded({ message: "registration failed" })),
            ),
        });
        expect(refused.session).toBeUndefined();
        expect(refused.retainedWork).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(world({ config, runtimes: [runtime] })));
      yield* Effect.gen(function* () {
        const sessions = yield* Session;
        const core = yield* Core;
        yield* sessions.restore;
        const channel = (yield* Channel).defaultChannel();
        const hired = yield* sessions.send({ ...profile(), id: "other", name: "Other" }, "second", "", { context: { kind: "channel", channel } });
        const id = hired.session?.id;
        expect(id).toBeDefined();
        if (!id) return;
        yield* until(() => core.session(id)?.phase._tag === "done", "the new profile's answer");
        expect(directories).toHaveLength(2);
        expect(directories[0]).not.toBe(directories[1]);
        expect(inherited).toBe(false);
        expect(readFileSync(join(directories[0] ?? "", "private.txt"), "utf8")).toBe("first profile\n");
      }).pipe(Effect.scoped, Effect.provide(world({ config, runtimes: [runtime] })));
    });
  });
});
