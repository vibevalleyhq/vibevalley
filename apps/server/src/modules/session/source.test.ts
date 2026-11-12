import { expect, test } from "vite-plus/test";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { world } from "#/testing/world.ts";

import type { SourceEvent } from "./mailbox.ts";
import { inputOf, readPayload, triggerOf, triggerPayload } from "./payload.ts";
import * as S from "./schema.ts";

test("regression: machine triggers are immutable source records and do not become chat messages", async () => {
  await using farm = await world();
  const { inside: mailbox, channel: chat, tool: tools } = farm;
  const channel = chat.defaultChannel();
  const before = await chat.history(channel);
  const event: SourceEvent = {
    source: "github",
    key: "repo#7:review:42",
    actor: { kind: "system", id: "reviewer" },
    text: "review detail ".repeat(100),
    data: { path: "src/run.ts", line: 42, diff_hunk: "@@ -1 +1 @@" },
    threads: ["github:repo#7"],
    addressed: "thread_owner",
    replyChannel: channel,
    at: 10,
  };
  const first = (await mailbox.record(event))!;
  const duplicate = await mailbox.record({ ...event, text: "changed on retry", at: 20 });
  expect(duplicate).toEqual(first);
  expect(first.card.summary.length).toBe(600);
  expect(first.card.totalChars).toBe(event.text.length);
  expect((await mailbox.readTrigger(first.id))?.payload).toEqual({ text: event.text, data: event.data });
  const page = await tools.readResource(defaultOrchestrator, { uri: first.card.readUri, limit: 16000 });
  expect(page.text).toContain("src/run.ts");
  expect(page.text).toContain(event.text);
  const recorded = await mailbox.record({ ...event, key: "self", selfEcho: true });
  expect(recorded).toBeUndefined();
  const history2 = await chat.history(channel);
  expect(history2).toEqual(before);
});

test("regression: trigger control fields reject malformed values and preserve voice and attachment context", () => {
  const trigger = triggerOf({
    source: "voice",
    key: "voice-control",
    actor: { kind: "user", id: "user" },
    addressed: "direct",
    threads: [],
    text: "voice input",
    at: 0,
    meta: {
      issue: "original",
      trigger: { kind: "comment" },
      inputContext: {
        number: 7,
        target: "#room",
        responsePort: "call-route",
        voiceMode: "conversation",
        attachments: [{ name: "note.txt", path: "/tmp/note.txt" }],
      },
      channelType: "channel",
    },
  });
  for (const meta of [
    { dispatch: "true" },
    { botRound: "3" },
    { kind: "unknown" },
    { trigger: { kind: "unknown" } },
    { inputContext: { number: 7, target: 42 } },
  ])
    expect(S.Trigger.safeParse({ ...trigger, meta }).success).toBe(false);
  const decoded = S.Trigger.parse(JSON.parse(JSON.stringify(trigger)));
  const payload = readPayload(JSON.stringify(triggerPayload(decoded, "assigned")));
  const message = inputOf({ envelope_id: trigger.id, payload });
  expect(payload.trigger.meta.issue).toBe("assigned");
  expect(decoded.meta.issue).toBe("original");
  expect(message.responsePort).toBe("call-route");
  expect(message.voiceMode).toBe("conversation");
  expect(message.attachments).toEqual([{ name: "note.txt", path: "/tmp/note.txt" }]);
});
