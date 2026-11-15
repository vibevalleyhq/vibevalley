import { join } from "node:path";

import { describe, expect, it, test } from "vite-plus/test";

import { defaultOrchestrator, userId } from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";
import { tempDir } from "@vibevalley/testkit/temp";

import { Inconsistent } from "#/base/errors.ts";
import { makeCore, type Projection } from "#/core/core.ts";
import { defaults, type ServerConfig } from "#/infra/config.ts";
import { openDb } from "#/infra/db.ts";
import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { makeAttachment } from "#/platform/attachment/attachment.ts";

import { type ChannelWatchPort, makeChannel } from "./channel.ts";
import type { ChannelService } from "./contracts.ts";
import { mentionsIn } from "./mentions.ts";
import { parseSearch } from "./messages.ts";
import { Members } from "./store.ts";

test("an @ right after Chinese names someone, and one inside a Latin word or an address does not", () => {
  expect(mentionsIn("问@w3 看看")).toEqual(["w3"]);
  expect(mentionsIn("「@w3」你呢")).toEqual(["w3"]);
  expect(mentionsIn("mail a@w3.dev, x@@w3")).toEqual([]);
});

test("with several orchestrators: 助手 is the place's, and each is named by its id", () => {
  const names = { here: "lead", orchestrators: ["orchestrator", "lead", "agent-1", "agent-12"] };
  expect(mentionsIn("@助手 看看，@agent-12 也看看，@agent-1", names)).toEqual(["lead", "agent-12", "agent-1"]);
  expect(mentionsIn("@orchestrator 你呢 `@lead`", names)).toEqual(["orchestrator"]);
  expect(mentionsIn("@lead 在吗")).toEqual([]);
});

describe("channel follows", () => {
  it("loads and updates who follows each thread", () => {
    const follows = new Members();
    follows.load([{ channel_id: "t", participant_id: "w3" }]);
    follows.memberAdded("t", "w1");
    follows.memberAdded("t", "w3");
    expect(follows.membersOf("t")).toEqual(["w1", "w3"]);
    expect(follows.membersOf("other")).toEqual([]);
  });

  it("forgets a session that left", () => {
    const follows = new Members();
    follows.load([
      { channel_id: "t", participant_id: "w3" },
      { channel_id: "u", participant_id: "w3" },
      { channel_id: "u", participant_id: "w1" },
    ]);
    follows.left("w3");
    expect([follows.membersOf("t"), follows.membersOf("u")]).toEqual([[], ["w1"]]);
  });
});

describe("a search", () => {
  it("reads its filters out of its words, and leaves one it cannot read among them", () => {
    expect(parseSearch("苹果 from:助手 in:#clock-in has:image has:link")).toEqual({
      words: "苹果",
      from: defaultOrchestrator,
      in: "clock-in",
      has: ["image", "link"],
    });
    expect(parseSearch("from:@用户 来了").from).toBe(userId);
    expect(parseSearch("from:w3").from).toBe("w3");
    const day = parseSearch("before:2026-10-28 after:2026-10-01 has:pdf");
    expect([day.before, day.after, day.words]).toEqual([new Date(2026, 9, 28).getTime(), new Date(2026, 9, 1).getTime(), "has:pdf"]);
    expect(parseSearch("before:明天").words).toBe("before:明天");
  });
});

describe("ChannelWatchPort", () => {
  it("carves the watch-facing event, seating, cursor, and note port out of ChannelService on Platform alone", async () => {
    const home = tempDir("channel-port-");
    const base = defaults(home);
    const config: ServerConfig = { ...base, home, workRoot: join(home, "work"), db: "memory" };
    const log = keptLog("channel-port");
    const db = await openDb(config, log, wallTime);
    const projection: Projection = {
      reduce: (state) => [state, false],
      effects: () => [],
      frame: () => {
        throw new Inconsistent("unused in channel unit test");
      },
    };
    const core = makeCore({ projection, clock: wallTime });
    const attachment = await makeAttachment({ config, clock: wallTime, db });
    const chat: ChannelService = await makeChannel({
      clock: wallTime,
      log,
      fetch: () => Promise.reject(new Error("offline")),
      db,
      core,
      attachment,
    });
    try {
      const watchPort: ChannelWatchPort = chat;
      const seenSeqs: number[] = [];
      watchPort.awaitReader(async (seq) => {
        seenSeqs.push(seq);
      });
      const sub = watchPort.committed();
      try {
        await watchPort.seat({ id: defaultOrchestrator, name: "助手" });
        await watchPort.seat({ id: "w1", name: "帮工w1", agent: "lab" });
        const dm = await watchPort.createDirect(defaultOrchestrator);
        expect(watchPort.place(dm)?.type).toBe("direct");

        const said = await chat.say({ text: "@w1 你好", sendKey: "port-1" });
        const next = await sub.next();
        expect(next.done).toBe(false);
        if (next.done === true) throw new Inconsistent("expected committed event");
        expect(next.value.kind).toBe("posted");
        expect(seenSeqs.length).toBeGreaterThan(0);

        const events = await watchPort.events(0);
        expect(events.some((e) => e.message === said.message.id && e.kind === "posted")).toBe(true);
        const committed = await watchPort.committedOf(said.message.id);
        expect(committed?.mentions).toEqual(["w1"]);

        await watchPort.markSeen("w1", said.message.id);
        expect(await chat.unread("w1", chat.defaultChannel())).toEqual([]);

        const opened = await watchPort.note({
          channel: chat.defaultChannel(),
          from: defaultOrchestrator,
          kind: "dispatch",
          text: "派单",
          meta: { session: sessionId("w1") },
          topic: { kind: "talk", id: "w1", owner: "w1" },
        });
        expect(watchPort.threadAbout("talk", "w1")).toBe(opened.thread);
        expect(await watchPort.dispatches(opened.thread)).toBe(0);
      } finally {
        sub.close();
      }
    } finally {
      await chat.close();
      core.close();
      await db.close();
    }
  });
});
