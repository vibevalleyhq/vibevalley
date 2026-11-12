import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { describe, expect, test } from "vite-plus/test";

import { channelOf } from "@vibevalley/protocol/rules";

import { shiftedTime, testConfig, waitFor, within } from "#/testing/layers.ts";
import { sqlOf } from "#/testing/sql.ts";

import { farm, lab, until } from "./farm.ts";

describe("a talk with a helper profile", () => {
  test("regression: a direct conversation keeps its context across idle suspension without a work assignment", async () => {
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
    const clock = shiftedTime();
    const f = farm({ runtime, clock, config: { ...config, chat: { ...config.chat, noticeBatchMs: 1 } } });
    await using fw = await f.open();
    const issues = fw.issue;
    const channels = fw.channel;
    const sessions = fw.inside;
    const core = fw.core;
    const sql = sqlOf(fw.db);
    const { in: saidIn } = fw.said;
    await fw.agent.save(lab());
    const dm = await channels.direct("lab");
    const direct2 = await channels.direct("lab");
    expect(direct2).toBe(dm);
    const channel = channelOf(core.state().chat, dm);
    expect([channel?.type, channel?.peer, channel?.subjectKind, channel?.subjectId]).toEqual(["direct", "profile:lab", null, undefined]);
    const answers = () => saidIn(dm).filter((m) => m.kind === "report").length;
    await channels.post({ _tag: "User", text: "你好，记得这段对话", channel: dm, sendKey: "" });
    await until(() => answers() === 1, "the first answer");
    const first = sessions.hired().find((s) => s.channel === dm);
    expect(first).toMatchObject({ agent: "lab", channel: dm });
    expect(first?.issue).toBeUndefined();
    expect(first?.repo).toBeUndefined();
    clock.adjust(10 * 60_000);
    await until(() => disposed === 1, "the idle execution suspended");
    expect(sessions.hired().find((s) => s.channel === dm)?.id).toBe(first?.id);
    await channels.post({ _tag: "User", text: "接着聊", channel: dm, sendKey: "" });
    await until(() => answers() === 2, "the resumed answer");
    expect(
      sessions
        .hired()
        .filter((s) => s.channel === dm)
        .map((s) => s.id),
    ).toEqual([first?.id]);
    expect(remembered).toBe(true);
    expect(resumes[1]).toBe(nativeIds[0]);
    expect(inputs[0]).toContain("你好，记得这段对话");
    expect(inputs[1]).toContain("接着聊");
    const issues2 = await issues.list();
    expect(issues2).toEqual([]);
    const history2 = await issues.history();
    expect(history2).toEqual([]);
    const rows = await sql`select id from issue_assignment`;
    expect(rows).toEqual([]);
    expect(saidIn(channels.defaultChannel())).toEqual([]);
  });

  test("regression: words during startup reach one chat context and its initial input is not seen before it speaks", async () => {
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
    await using fw = await f.open();
    const channels = fw.channel;
    const sessions = fw.inside;
    const sql = sqlOf(fw.db);
    const said = fw.said.in;
    await fw.agent.save(lab());
    const dm = await channels.direct("lab");
    await channels.post({ _tag: "User", text: "第一句", channel: dm, sendKey: "" });
    await opening.promise;
    await channels.post({ _tag: "User", text: "启动中的第二句", channel: dm, sendKey: "" });
    opened.resolve();
    await until(() => sessions.hired().some((s) => s.channel === dm), "the context registered");
    releaseFirst.resolve();
    await until(() => said(dm).filter((m) => m.kind === "report").length === 2, "both inputs answered");
    expect(starts).toBe(1);
    expect(inputs.some((input) => input.includes("启动中的第二句"))).toBe(true);
    const after = await waitFor(
      () =>
        sql<{
          state: string;
        }>`select d.state from session_delivery d join channel_message m on m.id = d.message_id where m.channel_id = ${dm} order by m.number`,
      (rows) => rows.length === 2 && rows.every((row) => row.state === "consumed"),
      "both inputs consumed",
    );
    expect(after.map((d) => d.state)).toEqual(["consumed", "consumed"]);
    // Seen only once its turn has started: handed first, consumed no earlier than the run it opened. Read from the
    // times, not from a state caught in between, which a fast write passes before anyone looks.
    const [first] = await sql<{
      handed_at: number;
      consumed_at: number;
    }>`select d.handed_at, d.consumed_at from session_delivery d join channel_message m on m.id = d.message_id where m.channel_id = ${dm} order by m.number limit 1`;
    const [run] = await sql<{ started_at: number }>`select started_at from session_run order by started_at limit 1`;
    expect(first && run).toBeTruthy();
    expect(first!.handed_at).toBeLessThanOrEqual(run!.started_at);
    expect(run!.started_at).toBeLessThanOrEqual(first!.consumed_at);
  });

  test("regression: restarting keeps the direct channel and resumes the same conversation", async () => {
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
    const first = await (async () => {
      await using fw = await farm({ config, runtime }).open();
      const channels = fw.channel;
      const sessions = fw.inside;
      const said = fw.said.in;
      await fw.agent.save(lab());
      const dm = await channels.direct("lab");
      await channels.post({ _tag: "User", text: "重启之前", channel: dm, sendKey: "" });
      await until(() => said(dm).some((m) => m.kind === "report"), "the first report");
      const sql = sqlOf(fw.db);
      await waitFor(
        () => sql<{ state: string }>`select d.state from session_delivery d join channel_message m on m.id = d.message_id where m.channel_id = ${dm}`,
        (rows) => rows.length === 1 && rows[0]?.state === "consumed",
        "the input receipt persisted before restart",
      );
      const context = sessions.hired().find((s) => s.channel === dm);
      if (!context) throw new Error("the conversation has no session");
      fw.core.apply({ type: "progressChanged", station: { id: context.id, station: 3 } });
      return { dm, session: context.id };
    })();

    expect(existsSync(join(config.home, "state.json"))).toBe(false);
    {
      await using fw = await farm({ config, runtime }).open();
      const channels = fw.channel;
      const sessions = fw.inside;
      const said = fw.said.in;
      await fw.watch.boot();
      const direct2 = await channels.direct("lab");
      expect(direct2).toBe(first.dm);
      expect(sessions.hired().find((s) => s.channel === first.dm)?.id).toBe(first.session);
      expect(fw.core.state().plays?.[first.session]?.station).toBe(0);
      await channels.post({ _tag: "User", text: "重启之后", channel: first.dm, sendKey: "" });
      await until(() => said(first.dm).some((m) => m.kind === "report"), "the answer after restart");
      expect(resumes[1]).toBeTruthy();
      expect(inputs[1]).toContain("重启之后");
      const found = await fw.issue.list();
      expect(found).toEqual([]);
    }
  });

  test("regression: registering a new chat cannot deadlock a message to an existing conversation", async () => {
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
    await using fw = await f.open();
    const channels = fw.channel;
    const agents = fw.agent;
    const said = fw.said.in;
    const sql = sqlOf(fw.db);
    await agents.save(lab());
    await agents.save({ ...lab(), id: "lab2", name: "Lab Two" });
    const existing = await channels.direct("lab");
    const starting = await channels.direct("lab2");
    await channels.post({ _tag: "User", text: "B first", channel: existing, sendKey: "" });
    await until(() => said(existing).filter((m) => m.kind === "report").length === 1, "the existing conversation ready");
    await channels.post({ _tag: "User", text: "A first", channel: starting, sendKey: "" });
    await opening.promise;
    const delivery = channels.post({ _tag: "User", text: "B next", channel: existing, sendKey: "" });
    await until(() => said(existing).some((m) => m.text === "B next"), "the followup committed under the channel lock");
    releaseOpening.resolve();
    await within(delivery, 3_000, "the followup delivery");
    await until(
      () => said(starting).filter((m) => m.kind === "report").length === 1 && said(existing).filter((m) => m.kind === "report").length === 2,
      "both conversations answered",
    );
    expect(starts).toBe(2);
    const delivered = await waitFor(
      () => sql<{ state: string }>`select d.state from session_delivery d join channel_message m on m.id = d.message_id where m.channel_id = ${starting}`,
      (rows) => rows.length === 1 && rows[0]?.state === "consumed",
      "the initial delivery seen",
    );
    expect(delivered.map((d) => d.state)).toEqual(["consumed"]);
  });
});
