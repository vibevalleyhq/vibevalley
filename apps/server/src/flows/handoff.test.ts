import { expect, test } from "vite-plus/test";

import { farm } from "./farm.ts";

test("regression: user read cursors and later replies suppress external notifications", async () => {
  const f = farm();
  await using fw = await f.open();
  const chat = fw.channel;
  const inbox = fw.inbox;
  const channel = chat.defaultChannel();
  const agent = chat.orchestratorIn(channel);
  await chat.post({ _tag: "Run", from: agent, channel: channel, text: "需要你确认", run: "read-receipt" });
  const message = (await chat.history(channel)).at(-1)!;
  const handoffState2 = await inbox.handoffState(message.id);
  expect(handoffState2).toBe("unseen");
  await chat.markRead(channel, message.number);
  const handoffState3 = await inbox.handoffState(message.id);
  expect(handoffState3).toBe("seen");
  await chat.post({ _tag: "User", text: "确认", channel: channel, sendKey: "user-reply" });
  const handoffState4 = await inbox.handoffState(message.id);
  expect(handoffState4).toBeUndefined();
  await chat.post({ _tag: "Run", from: agent, channel: channel, text: "又有一项变化", run: "incremental-update" });
  const update = (await chat.history(channel)).at(-1)!;
  const handoffState5 = await inbox.handoffState(update.id);
  expect(handoffState5).toBe("unseen");
});
