import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import { describe, expect, test } from "vite-plus/test";

import { maxRunning } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import { starter, testConfig, until, waitFor } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";

import { HireRefused, NotRecorded } from "./session.ts";
import type { DeliveryInput } from "./signals.ts";

const profile = () => ({ ...starter("lab"), effort: "" });
const delivery = (trigger: DeliveryInput["trigger"]): DeliveryInput => ({ trigger, envelopeIds: [], byUserComment: false });
const failure = <A>(p: Promise<A>) =>
  p.then(
    () => {
      throw new Error("it did not fail");
    },
    (e: unknown) => e,
  );

describe("an agent's channel context", () => {
  test("regression: a channel context resumes without an issue or a repo checkout", async () => {
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
    await using farm = await world({ config, runtimes: [runtime] });
    const sessions = farm.session;
    const machines = farm.session;
    const executor = machines.executions(machines.here());
    const core = farm.core;
    const repos = farm.repo;
    const channel = farm.channel.defaultChannel();
    const agent = profile();
    await farm.agent.save(agent);
    const { session } = await sessions.hire(agent, "discuss", "must-not-create", { context: { kind: "channel", channel } });
    await until(() => core.session(session.id)?.phase._tag === "done", "the first answer");
    expect(session.issue).toBeUndefined();
    expect(session.repo).toBeUndefined();
    expect(session.channel).toBe(channel);
    expect(core.state().issues).toEqual([]);
    const repos2 = await repos.list();
    expect(repos2).toEqual([]);
    const cwd = turns[0]?.options.cwd ?? "";
    expect(dirname(cwd)).toBe(join(realpathSync(config.workRoot), "contexts"));
    expect(basename(cwd).startsWith(session.id + "-")).toBe(true);
    const native = executor.find(session.id)?.sessionId;
    const suspend2 = await sessions.suspend(session.id);
    expect(suspend2).toBe(true);
    expect(executor.find(session.id)).toBeUndefined();
    expect(sessions.sessionOf(session.id)?.id).toBe(session.id);
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("turn 1\n");
    const delivered = await sessions.deliver(session.id, "continue", delivery({ kind: "comment", channel }));
    expect(delivered).toMatchObject({ kind: "run", woke: true });
    await until(() => core.session(session.id)?.runs === 2, "the continued answer");
    const kept = await waitFor(
      async () => (await sessions.events(session.id)) ?? [],
      (events) => events.filter((event) => event.type === "run/end").length === 2,
      "the context's run ends",
    );
    const starts = kept.filter((event) => event.type === "run/start");
    const ends = kept.filter((event) => event.type === "run/end");
    expect([starts.length, ends.length, new Set(starts.map((event) => event.run)).size]).toEqual([2, 2, 2]);
    expect(turns[1]?.options.resume).toBe(native);
    expect(turns[1]?.options.cwd).toBe(cwd);
    let merged = false;
    const refused = await failure(
      sessions.handOver(session.id, "merged", async () => {
        merged = true;
        return { text: "", commits: 0 };
      }),
    );
    expect(refused).toMatchObject({ bizCode: BizCode.SessionRefused });
    expect(merged).toBe(false);
    expect(await failure(sessions.discardWork(session.id))).toMatchObject({ bizCode: BizCode.SessionRefused });
    expect(await failure(sessions.dismiss(session.id, "discard"))).toMatchObject({ bizCode: BizCode.SessionRefused });
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("turn 2\n");
  });

  test("regression: freeing an idle channel execution keeps its session identity", async () => {
    const runtime = scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("结论：回答了") });
    await using farm = await world({ runtimes: [runtime] });
    const sessions = farm.session;
    const machines = farm.session;
    const executor = machines.executions(machines.here());
    const core = farm.core;
    const chat = farm.channel;
    const agent = profile();
    await farm.agent.save(agent);
    const ids: string[] = [];
    for (let i = 0; i < maxRunning; i++) {
      const channel = (await chat.openChannel(`context-${i}`, "", "")).id;
      const { session } = await sessions.hire(agent, "discuss", "", { context: { kind: "channel", channel } });
      const id = session.id;
      ids.push(id);
      await until(() => core.session(id)?.phase._tag === "done", "an answer");
    }
    expect(executor.all()).toHaveLength(maxRunning);
    const room = await sessions.makeRoom("pi", "");
    expect(room).toHaveProperty("evicted");
    expect(executor.all()).toHaveLength(maxRunning - 1);
    expect(sessions.hired().map((s) => s.id)).toEqual(ids);
    for (const id of ids) await sessions.suspend(id);
    const room2 = await sessions.makeRoom("pi", "");
    expect(room2).toEqual({});
    expect(sessions.hired()).toHaveLength(maxRunning);
  });

  test("regression: a failed channel opening removes only its empty context directory", async () => {
    const config = testConfig();
    await using farm = await world({ config });
    const sessions = farm.session;
    const channel = farm.channel.defaultChannel();
    const agent = { ...profile(), runtime: "not-installed" };
    const hired = await failure(sessions.hire(agent, "discuss", "", { context: { kind: "channel", channel } }));
    expect(hired).toBeInstanceOf(HireRefused);
    expect(hired).toMatchObject({ retainedWork: undefined });
    expect(readdirSync(join(config.workRoot, "contexts"))).toEqual([]);
    expect(sessions.hired()).toEqual([]);
  });

  test("regression: a channel opening whose execution cannot close keeps its files and blocks a second writer", async () => {
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
    await using farm = await world({ config, runtimes: [runtime] });
    const sessions = farm.session;
    const channel = farm.channel.defaultChannel();
    const agent = profile();
    await farm.agent.save(agent);
    const hired = await failure(
      sessions.hire(agent, "first", "", {
        context: { kind: "channel", channel },
        hiring: async () => {
          await written;
          throw new NotRecorded("registration failed");
        },
      }),
    );
    expect(hired).toBeInstanceOf(HireRefused);
    expect(hired).toMatchObject({ retainedWork: true });
    expect(readFileSync(join(cwd, "kept.txt"), "utf8")).toBe("keep\n");
    const again = await failure(sessions.hire(agent, "again", "", { context: { kind: "channel", channel } }));
    expect(again).toBeInstanceOf(HireRefused);
    expect(again).toMatchObject({ retainedWork: true });
    expect(opened).toBe(1);
    expect(readdirSync(join(config.workRoot, "contexts"))).toHaveLength(1);
  });

  test("regression: a restarted channel context keeps its reply channel and native resume id", async () => {
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
    {
      await using farm = await world({ config, runtimes: [runtime] });
      const sessions = farm.session;
      const machines = farm.session;
      const executor = machines.executions(machines.here());
      const core = farm.core;
      const agent = profile();
      await farm.agent.save(agent);
      channel = farm.channel.defaultChannel();
      const { session } = await sessions.hire(agent, "first", "", { context: { kind: "channel", channel } });
      id = session.id;
      expect(id).not.toBe("");
      await until(() => core.session(id)?.phase._tag === "done", "the answer before restart");
      native = executor.find(id)?.sessionId;
      cwd = sessions.cwdOf(id) ?? "";
      await sessions.suspend(id);
    }
    {
      await using farm = await world({ config, runtimes: [runtime] });
      const sessions = farm.session;
      const core = farm.core;
      await sessions.restore();
      expect(sessions.sessionOf(id)?.channel).toBe(channel);
      expect(sessions.sessionOf(id)?.issue).toBeUndefined();
      expect(existsSync(join(cwd, "kept.txt"))).toBe(true);
      const delivered = await sessions.deliver(id, "after restart", delivery({ kind: "comment", channel }));
      expect(delivered).toMatchObject({ kind: "run", woke: true });
      await until(() => core.session(id)?.runs === 2, "the answer after restart");
      expect(turns[1]?.options.resume).toBe(native);
      await sessions.dismiss(id);
      expect((await sessions.get(id))?.channel).toBe(channel);
    }
  });

  test("regression: an unregistered context retained across restart is never reused by another profile", async () => {
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
    {
      await using farm = await world({ config, runtimes: [runtime] });
      const sessions = farm.session;
      const channel = farm.channel.defaultChannel();
      const refused = await failure(
        sessions.hire(profile(), "first", "", {
          context: { kind: "channel", channel },
          hiring: async () => {
            await written;
            throw new NotRecorded("registration failed");
          },
        }),
      );
      expect(refused).toBeInstanceOf(HireRefused);
      expect(refused).toMatchObject({ retainedWork: true });
    }
    {
      await using farm = await world({ config, runtimes: [runtime] });
      const sessions = farm.session;
      const core = farm.core;
      await sessions.restore();
      const channel = farm.channel.defaultChannel();
      const { session } = await sessions.hire({ ...profile(), id: "other", name: "Other" }, "second", "", { context: { kind: "channel", channel } });
      const id = session.id;
      await until(() => core.session(id)?.phase._tag === "done", "the new profile's answer");
      expect(directories).toHaveLength(2);
      expect(directories[0]).not.toBe(directories[1]);
      expect(inherited).toBe(false);
      expect(readFileSync(join(directories[0] ?? "", "private.txt"), "utf8")).toBe("first profile\n");
    }
  });
});
