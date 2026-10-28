import { describe, expect, it } from "@effect/vitest";
import { VibeValleyApi, VibeValleyApiError } from "@vibevalley/protocol";
import { Effect, Layer } from "effect";
import { testConfig } from "../testing/layers.ts";
import { quietApp } from "../testing/world.ts";
import { app } from "./app.ts";

const farm = Effect.gen(function* () {
  let address = "";
  yield* Layer.build(app(testConfig(), 0, (a) => Effect.sync(() => void (address = a)), quietApp));
  return new VibeValleyApi(`http://${address}`, (url, init) => fetch(url, init));
});

const call = <A>(p: () => Promise<A>) => Effect.promise(() => p());
const refusal = (p: () => Promise<unknown>) =>
  Effect.promise(() =>
    p().then(
      () => "",
      (e: unknown) => (e instanceof VibeValleyApiError ? e.tag : String(e)),
    ),
  );

describe("the endpoints the agents' tools stand on", () => {
  it.live("list channels and unread places, filter issues, review and split them, read graphs, search memories, write blocks", () =>
    Effect.gen(function* () {
      const api = yield* farm;
      const channels = yield* call(() => api.channel.list());
      expect(channels.map((c) => c.type)).toEqual(["channel", "direct"]);
      expect(yield* call(() => api.channel.unread.list())).toEqual([]);

      const open = yield* call(() => api.issue.create({ title: "修登录", project: "app" }));
      yield* call(() => api.issue.create({ title: "加打卡" }));
      expect((yield* call(() => api.issue.list({}))).map((t) => t.title).sort()).toEqual(["修登录", "加打卡"]);
      expect((yield* call(() => api.issue.list({ project: "app" }))).map((t) => t.title)).toEqual(["修登录"]);
      expect(yield* call(() => api.issue.list({ status: "done" }))).toEqual([]);
      // Nothing was handed back to review, and no session works it to split it.
      expect(yield* refusal(() => api.issue.review({ id: `#${open.number}`, pass: true }))).toBe("Refused");
      expect(yield* refusal(() => api.issue.split({ id: open.id, tasks: [{ id: "a", brief: "前端" }] }))).toBe("Refused");

      expect(yield* call(() => api.graph.list())).toEqual([]);
      expect(yield* refusal(() => api.graph.get({ id: "nope" }))).toBe("Missing");
      expect(yield* call(() => api.memory.search({ text: "登录" }))).toMatchObject({ found: [] });

      const doc = yield* call(() => api.doc.create({ title: "说明" }));
      const made = yield* call(() => api.doc.block.create({ id: doc.doc.id, type: "heading", level: 1, text: "开头" }));
      expect(made).toMatchObject({ status: "applied", rev: 1 });
      expect(yield* call(() => api.doc.block.update({ id: doc.doc.id, block: made.blockId, baseRev: 1, text: "新的开头" }))).toMatchObject({
        status: "applied",
      });
      expect(yield* call(() => api.doc.block.update({ id: doc.doc.id, block: made.blockId, baseRev: 1, text: "晚了" }))).toMatchObject({
        status: "conflict",
      });
      expect(yield* refusal(() => api.doc.block.create({ id: doc.doc.id, type: "divider", text: "" }))).toBe("Refused");
    }).pipe(Effect.scoped),
  );
});
