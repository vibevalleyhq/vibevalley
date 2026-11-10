import { expect, it } from "@effect/vitest";
import { Effect, Formatter, Schema } from "effect";

import { defaultOrchestrator } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { Channel } from "#/channel/channel.ts";
import { inputOf, readPayload, triggerOf, triggerPayload } from "#/mailbox/payload.ts";
import { Resource } from "#/resource/resource.ts";
import { world } from "#/testing/world.ts";

import { Ingress, type SourceEvent } from "./ingress.ts";

it.live("regression: machine triggers are immutable source records and do not become chat messages", () =>
  Effect.gen(function* () {
    const ingress = yield* Ingress;
    const chat = yield* Channel;
    const resources = yield* Resource;
    const channel = chat.defaultChannel();
    const before = yield* chat.history(channel);
    const event: SourceEvent = {
      source: "github",
      key: "repo#7:review:42",
      actor: { kind: "collaborator", id: "reviewer" },
      text: "review detail ".repeat(100),
      data: { path: "src/run.ts", line: 42, diff_hunk: "@@ -1 +1 @@" },
      threads: ["github:repo#7"],
      addressed: "thread_owner",
      replyChannel: channel,
      at: 10,
    };
    const first = (yield* ingress.record(event))!;
    const duplicate = yield* ingress.record({ ...event, text: "changed on retry", at: 20 });
    expect(duplicate).toEqual(first);
    expect(first.card.summary.length).toBe(600);
    expect(first.card.totalChars).toBe(event.text.length);
    expect((yield* ingress.read(first.id))?.payload).toEqual({ text: event.text, data: event.data });
    const page = yield* resources.read(defaultOrchestrator, { uri: first.card.readUri, limit: 16000 });
    expect(page.text).toContain("src/run.ts");
    expect(page.text).toContain(event.text);
    const recorded = yield* ingress.record({ ...event, key: "self", selfEcho: true });
    expect(recorded).toBeUndefined();
    const history2 = yield* chat.history(channel);
    expect(history2).toEqual(before);
  }).pipe(Effect.scoped, Effect.provide(world())),
);

it("regression: trigger control fields reject malformed values and preserve voice and attachment context", () => {
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
    expect(Schema.is(S.Trigger)({ ...trigger, meta })).toBe(false);
  const decoded = Schema.decodeUnknownSync(S.Trigger)(JSON.parse(Formatter.formatJson(trigger)));
  const payload = readPayload(Formatter.formatJson(triggerPayload(decoded, "assigned")));
  const message = inputOf({ envelope_id: trigger.id, payload });
  expect(payload.trigger.meta.issue).toBe("assigned");
  expect(decoded.meta.issue).toBe("original");
  expect(message.responsePort).toBe("call-route");
  expect(message.voiceMode).toBe("conversation");
  expect(message.attachments).toEqual([{ name: "note.txt", path: "/tmp/note.txt" }]);
});
