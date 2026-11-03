import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { Channel } from "@/channel/channel.ts";
import { Resource } from "@/resource/resource.ts";
import { world } from "@/testing/world.ts";

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
    expect(yield* ingress.record({ ...event, key: "self", selfEcho: true })).toBeUndefined();
    expect(yield* chat.history(channel)).toEqual(before);
  }).pipe(Effect.scoped, Effect.provide(world())),
);
