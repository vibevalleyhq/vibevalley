import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { channelOf } from "@vibevalley/protocol/rules";

import { Agent } from "#/agent/agent.ts";
import { Channel } from "#/channel/channel.ts";
import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import { Issue } from "#/issue/issue.ts";
import { Session } from "#/session/session.ts";
import { testConfig, waitFor } from "#/testing/layers.ts";
import { Said } from "#/testing/world.ts";

import { farm, lab, until } from "./farm.ts";

describe("a talk with a helper profile", () => {
  it.effect("regression: a direct conversation keeps its context across idle suspension without a work assignment", () => {
    const inputs: string[] = [];
    const nativeIds: string[] = [];
    const resumes: unknown[] = [];
    let disposed = 0;
    let remembered = false;
    const base = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        inputs.push(turn.input);
        resumes.push(turn.options.resume);
        const note = join(turn.options.cwd, "conversation.txt");
        remembered = existsSync(note);
        writeFileSync(note, "remember this conversation");
        turn.say("在呢");
      },
    });
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        const session = await base.session(...args);
        nativeIds.push(session.id);
        return {
          ...session,
          dispose: async () => {
            await session.dispose();
            disposed++;
          },
        };
      },
    };
    const config = testConfig();
    const f = farm({ runtime, config: { ...config, chat: { ...config.chat, noticeBatchMs: 1 } } });
    return Effect.gen(function* () {
      const issues = yield* Issue;
      const channels = yield* Channel;
      const sessions = yield* Session;
      const core = yield* Core;
      const db = yield* Db;
      const sql = yield* SqlClient.SqlClient;
      const { in: saidIn } = yield* Said;
      yield* (yield* Agent).save(lab());
      const dm = yield* channels.direct("lab");
      const direct2 = yield* channels.direct("lab");
      expect(direct2).toBe(dm);
      const channel = channelOf(core.state().chat, dm);
      expect([channel?.type, channel?.peer, channel?.subjectKind, channel?.subjectId]).toEqual(["direct", "profile:lab", null, undefined]);
      const answers = () => saidIn(dm).filter((m) => m.kind === "report").length;
      yield* channels.say("你好，记得这段对话", dm, "");
      yield* until(() => answers() === 1, "the first answer");
      const first = sessions.workers().find((s) => s.channel === dm);
      expect(first).toMatchObject({ agent: "lab", channel: dm });
      expect(first?.issue).toBeUndefined();
      expect(first?.repo).toBeUndefined();
      yield* TestClock.adjust(10 * 60_000);
      yield* until(() => disposed === 1, "the idle execution suspended");
      expect(sessions.workers().find((s) => s.channel === dm)?.id).toBe(first?.id);
      yield* channels.say("接着聊", dm, "");
      yield* until(() => answers() === 2, "the resumed answer");
      expect(
        sessions
          .workers()
          .filter((s) => s.channel === dm)
          .map((s) => s.id),
      ).toEqual([first?.id]);
      expect(remembered).toBe(true);
      expect(resumes[1]).toBe(nativeIds[0]);
      expect(inputs[0]).toContain("你好，记得这段对话");
      expect(inputs[1]).toContain("接着聊");
      const issues2 = yield* issues.list();
      expect(issues2).toEqual([]);
      const history2 = yield* issues.history();
      expect(history2).toEqual([]);
      const rows = yield* db.run(sql`select id from issue_assignment`);
      expect(rows).toEqual([]);
      expect(saidIn(channels.defaultChannel())).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("regression: words during startup reach one chat context and its initial input is not seen before it speaks", () => {
    const opening = Promise.withResolvers<void>();
    const opened = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const inputs: string[] = [];
    let starts = 0;
    const base = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        inputs.push(turn.input);
        if (inputs.length === 1) await releaseFirst.promise;
        turn.say("收到了");
      },
    });
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        starts++;
        opening.resolve();
        await opened.promise;
        return base.session(...args);
      },
    };
    const f = farm({ runtime });
    return Effect.gen(function* () {
      const channels = yield* Channel;
      const sessions = yield* Session;
      const db = yield* Db;
      const sql = yield* SqlClient.SqlClient;
      const said = (yield* Said).in;
      yield* (yield* Agent).save(lab());
      const dm = yield* channels.direct("lab");
      yield* channels.say("第一句", dm, "");
      yield* Effect.promise(() => opening.promise);
      yield* channels.say("启动中的第二句", dm, "");
      opened.resolve();
      yield* until(() => sessions.workers().some((s) => s.channel === dm), "the context registered");
      releaseFirst.resolve();
      yield* until(() => said(dm).filter((m) => m.kind === "report").length === 2, "both inputs answered");
      expect(starts).toBe(1);
      expect(inputs.some((input) => input.includes("启动中的第二句"))).toBe(true);
      const after = yield* waitFor(
        db.run(
          sql<{
            state: string;
          }>`select d.state from mailbox_delivery d join channel_message m on m.id = d.message_id where m.channel_id = ${dm} order by m.number`,
        ),
        (rows) => rows.length === 2 && rows.every((row) => row.state === "consumed"),
        "both inputs consumed",
      );
      expect(after.map((d) => d.state)).toEqual(["consumed", "consumed"]);
      // Seen only once its turn has started: handed first, consumed no earlier than the run it opened. Read from the
      // times, not from a state caught in between, which a fast write passes before anyone looks.
      const [first] = yield* db.run(
        sql<{
          handed_at: number;
          consumed_at: number;
        }>`select d.handed_at, d.consumed_at from mailbox_delivery d join channel_message m on m.id = d.message_id where m.channel_id = ${dm} order by m.number limit 1`,
      );
      const [run] = yield* db.run(sql<{ started_at: number }>`select started_at from session_run order by started_at limit 1`);
      expect(first && run).toBeTruthy();
      expect(first!.handed_at).toBeLessThanOrEqual(run!.started_at);
      expect(run!.started_at).toBeLessThanOrEqual(first!.consumed_at);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("regression: restarting keeps the direct channel and resumes the same conversation", () => {
    const config = testConfig({ db: "" });
    const inputs: string[] = [];
    const resumes: unknown[] = [];
    const runtime = scriptedRuntime({
      id: "pi",
      turn: async (turn) => {
        inputs.push(turn.input);
        resumes.push(turn.options.resume);
        turn.say("在呢");
      },
    });
    return Effect.gen(function* () {
      const first = yield* Effect.gen(function* () {
        const channels = yield* Channel;
        const sessions = yield* Session;
        const said = (yield* Said).in;
        yield* (yield* Agent).save(lab());
        const dm = yield* channels.direct("lab");
        yield* channels.say("重启之前", dm, "");
        yield* until(() => said(dm).some((m) => m.kind === "report"), "the first report");
        const db = yield* Db;
        const sql = yield* SqlClient.SqlClient;
        yield* waitFor(
          db.run(sql<{ state: string }>`select d.state from mailbox_delivery d join channel_message m on m.id = d.message_id where m.channel_id = ${dm}`),
          (rows) => rows.length === 1 && rows[0]?.state === "consumed",
          "the input receipt persisted before restart",
        );
        const context = sessions.workers().find((s) => s.channel === dm);
        if (!context) throw new Error("the conversation has no session");
        yield* (yield* Core).apply({ type: "progressChanged", station: { id: context.id, station: 3 } });
        return { dm, session: context.id };
      }).pipe(Effect.scoped, Effect.provide(farm({ config, runtime }).layer));
      expect(existsSync(join(config.home, "state.json"))).toBe(false);
      yield* Effect.gen(function* () {
        const channels = yield* Channel;
        const sessions = yield* Session;
        const said = (yield* Said).in;
        yield* channels.start;
        const direct2 = yield* channels.direct("lab");
        expect(direct2).toBe(first.dm);
        expect(sessions.workers().find((s) => s.channel === first.dm)?.id).toBe(first.session);
        expect((yield* Core).state().plays?.[first.session]?.station).toBe(0);
        yield* channels.say("重启之后", first.dm, "");
        yield* until(() => said(first.dm).some((m) => m.kind === "report"), "the answer after restart");
        expect(resumes[1]).toBeTruthy();
        expect(inputs[1]).toContain("重启之后");
        const found = yield* (yield* Issue).list();
        expect(found).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(farm({ config, runtime }).layer));
    });
  });

  it.live("regression: registering a new chat cannot deadlock a message to an existing conversation", () => {
    const opening = Promise.withResolvers<void>();
    const releaseOpening = Promise.withResolvers<void>();
    let starts = 0;
    const base = scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("收到了") });
    const runtime = {
      ...base,
      session: async (...args: Parameters<typeof base.session>) => {
        starts++;
        if (starts === 2) {
          opening.resolve();
          await releaseOpening.promise;
        }
        return base.session(...args);
      },
    };
    const f = farm({ runtime });
    return Effect.gen(function* () {
      const channels = yield* Channel;
      const agents = yield* Agent;
      const said = (yield* Said).in;
      const db = yield* Db;
      const sql = yield* SqlClient.SqlClient;
      yield* agents.save(lab());
      yield* agents.save({ ...lab(), id: "lab2", name: "Lab Two" });
      const existing = yield* channels.direct("lab");
      const starting = yield* channels.direct("lab2");
      yield* channels.say("B first", existing, "");
      yield* until(() => said(existing).filter((m) => m.kind === "report").length === 1, "the existing conversation ready");
      yield* channels.say("A first", starting, "");
      yield* Effect.promise(() => opening.promise);
      const delivery = yield* Effect.forkScoped(channels.say("B next", existing, ""));
      yield* until(() => said(existing).some((m) => m.text === "B next"), "the followup committed under the channel lock");
      releaseOpening.resolve();
      yield* Fiber.join(delivery).pipe(Effect.timeout(3_000));
      yield* until(
        () => said(starting).filter((m) => m.kind === "report").length === 1 && said(existing).filter((m) => m.kind === "report").length === 2,
        "both conversations answered",
      );
      expect(starts).toBe(2);
      const delivered = yield* waitFor(
        db.run(sql<{ state: string }>`select d.state from mailbox_delivery d join channel_message m on m.id = d.message_id where m.channel_id = ${starting}`),
        (rows) => rows.length === 1 && rows[0]?.state === "consumed",
        "the initial delivery seen",
      );
      expect(delivered.map((d) => d.state)).toEqual(["consumed"]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
