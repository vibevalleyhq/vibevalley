import { rmSync } from "node:fs";

import { expect, test } from "vite-plus/test";

import type { Core } from "#/core/core.ts";
import { frameOf } from "#/gateway/projection/frame.ts";
import { emptyPatrol, patrolStep } from "#/modules/inbox/patrol.ts";
import { testConfig } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";

const mentionIds = (core: Core) =>
  frameOf(core.state())
    .inbox.filter((item) => item.kind === "mention")
    .map((item) => item.id);

test("an unresolved user mention survives both history windows and restart until read", async () => {
  const config = testConfig({ db: "" });
  let thread = "";
  let message = "";
  let at = 0;
  let number = 0;
  const standing = (core: Core) => {
    expect(core.state().chat?.channels.some((c) => c.id === thread)).toBe(false);
    expect(mentionIds(core)).toEqual([message]);
    expect(patrolStep(core.state(), at + 16 * 60_000, emptyPatrol())[0].map((item) => item.key)).toEqual([message]);
  };
  try {
    {
      await using farm = await world({ config });
      const chat = farm.channel;
      const core = farm.core;
      const parent = (await chat.post({ _tag: "User", text: "需要确认的话题", sendKey: "" })).message;
      const written = (
        await chat.post({
          _tag: "Agent",
          from: "orchestrator",
          text: "@用户 请确认这份变更",
          target: `#general:${parent.number}`,
          anyway: true,
        })
      ).message!;
      ({ channel: thread, id: message, at, number } = written);
      expect(mentionIds(core)).toEqual([message]);
      for (let i = 0; i < 101; i++) {
        const other = (await chat.post({ _tag: "User", text: `其他话题 ${i}`, sendKey: "" })).message;
        const fresh = (await chat.post({ _tag: "Agent", from: "orchestrator", text: "其他答复", target: `#general:${other.number}`, anyway: true })).message!
          .channel;
        await chat.post({ _tag: "Notice", channel: fresh, text: "动静一", code: "history" });
        await chat.post({ _tag: "Notice", channel: fresh, text: "动静二", code: "history" });
      }
      standing(core);
    }
    {
      await using farm = await world({ config });
      standing(farm.core);
      await farm.channel.markRead(thread, number);
      expect(mentionIds(farm.core)).toEqual([]);
      expect(patrolStep(farm.core.state(), at + 16 * 60_000, emptyPatrol())[0]).toEqual([]);
    }
  } finally {
    rmSync(config.home, { recursive: true, force: true });
  }
});

test("only reading or replying in the mentioned channel completes a user mention", async () => {
  const config = testConfig();
  try {
    await using farm = await world({ config });
    const chat = farm.channel;
    const core = farm.core;
    const channel = await chat.openChannel("review", "", "");
    const first = (await chat.post({ _tag: "Agent", from: "orchestrator", text: "@用户 第一份变更", target: "#review", anyway: true })).message!;
    await chat.post({ _tag: "User", text: "默认频道的另一件事", sendKey: "" });
    expect(mentionIds(core)).toEqual([first.id]);
    await chat.post({ _tag: "User", text: "确认了", channel: channel.id, sendKey: "" });
    expect(mentionIds(core)).toEqual([]);
    const second = (await chat.post({ _tag: "Agent", from: "orchestrator", text: "@用户 第二份变更", target: "#review", anyway: true })).message!;
    expect(mentionIds(core)).toEqual([second.id]);
    await chat.markRead(channel.id, second.number);
    expect(mentionIds(core)).toEqual([]);
    const third = (await chat.post({ _tag: "Agent", from: "orchestrator", text: "@用户 第三份变更", target: "#review", anyway: true })).message!;
    expect(mentionIds(core)).toEqual([third.id]);
    await chat.read("user", { target: "#review" });
    expect(mentionIds(core)).toEqual([]);
  } finally {
    rmSync(config.home, { recursive: true, force: true });
  }
});
