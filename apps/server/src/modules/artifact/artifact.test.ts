import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Array as Arr, Effect } from "effect";
import { TestClock } from "effect/testing";

import { userId } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";
import { artifactId } from "@vibevalley/protocol/schema";

import { ServerConfig } from "#/infra/config.ts";
import { Channel } from "#/modules/channel/channel.ts";
import { world } from "#/testing/world.ts";

import { Artifact } from "./artifact.ts";
import { artifactMax } from "./policy.ts";

const user = { from: userId, by: userId };
const page = (words: string) => `<!doctype html><title>${words}</title><p>${words}</p>`;

describe("an artifact", () => {
  it.effect("is announced with its card where it belongs, and a new version keeps the old ones readable", () =>
    Effect.gen(function* () {
      const artifacts = yield* Artifact;
      const chat = yield* Channel;
      const general = chat.defaultChannel();
      const made = yield* artifacts.create(user, { title: " 详情：抽屉还是整页 ", kind: "html", content: page("抽屉"), note: "两种" });
      expect(made).toMatchObject({ title: "详情：抽屉还是整页", body: "html", channel: general, by: userId, version: 1 });
      expect(made.versions).toEqual([expect.objectContaining({ version: 1, note: "两种", channel: general, number: expect.any(Number) })]);
      const said = (yield* chat.history(general)).at(-1)!;
      expect(said.artifact).toEqual({ id: made.id, title: "详情：抽屉还是整页", body: "html", version: 1, note: "两种", display: "page" });
      expect(said.number).toBe(made.versions[0]!.number);

      const next = yield* artifacts.version(user, { id: made.id, content: page("整页"), note: "加了整页" });
      expect([next.version, next.versions.map((v) => v.version)]).toEqual([2, [1, 2]]);
      expect((yield* chat.history(general)).at(-1)!.artifact).toMatchObject({ id: made.id, version: 2, note: "加了整页" });
      const content2 = yield* artifacts.content(made.id);
      expect(content2).toMatchObject({ version: 2, content: page("整页"), body: "html" });
      const content3 = yield* artifacts.content(made.id, 1);
      expect(content3).toMatchObject({ version: 1, content: page("抽屉") });
      const contentFailure = yield* Effect.flip(artifacts.content(made.id, 3));
      expect(contentFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.ArtifactNotFound });

      yield* TestClock.adjust(1);
      const forIssue = yield* artifacts.create(user, { title: "调研", kind: "markdown", content: "# 结论\n\n用抽屉。", issue: "issue-1" });
      expect((yield* artifacts.list({ issue: "issue-1" })).map((a) => a.id)).toEqual([forIssue.id]);
      expect((yield* artifacts.list({ channel: general })).map((a) => a.id)).toEqual([forIssue.id, made.id]);
      expect((yield* artifacts.list({})).length).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.effect("handed in as Markdown is read into blocks to write on together, and takes no new version", () =>
    Effect.gen(function* () {
      const artifacts = yield* Artifact;
      const chat = yield* Channel;
      const made = yield* artifacts.create({ from: userId, by: "lab" }, { title: "调研", kind: "markdown", content: "# 结论\n\n用**抽屉**。", note: "初稿" });
      expect(made).toMatchObject({ body: "blocks", version: 0, seq: 1, versions: [] });
      expect((yield* chat.history(chat.defaultChannel())).at(-1)!.artifact).toEqual({ id: made.id, title: "调研", body: "blocks", version: 0, note: "初稿" });
      const snap = yield* artifacts.blocks(made.id);
      expect([snap.artifact.id, snap.blocks.map((b) => [b.type, b.updatedBy])]).toEqual([
        made.id,
        [
          ["heading", "lab"],
          ["paragraph", "lab"],
        ],
      ]);
      const content2 = yield* artifacts.content(made.id);
      expect(content2).toEqual({ version: 1, content: "# 结论\n\n用**抽屉**。\n", body: "blocks" });
      const versionFailure = yield* Effect.flip(artifacts.version(user, { id: made.id, content: "x" }));
      expect(versionFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.ArtifactRefused });
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.effect("started on the page with a title is empty and announced nowhere; an html one has no blocks and is shown as a page unless asked", () =>
    Effect.gen(function* () {
      const artifacts = yield* Artifact;
      const chat = yield* Channel;
      const before = (yield* chat.history(chat.defaultChannel())).length;
      const blank = yield* artifacts.create(user, { title: "周报", kind: "markdown" });
      expect(blank).toMatchObject({ body: "blocks", version: 0, seq: 0, by: userId });
      expect(blank.channel).toBeUndefined();
      expect([(yield* artifacts.blocks(blank.id)).blocks, (yield* chat.history(chat.defaultChannel())).length]).toEqual([[], before]);
      const html = yield* artifacts.create(user, { title: "页", kind: "html", content: page("页") });
      const blocksFailure = yield* Effect.flip(artifacts.blocks(html.id));
      expect(blocksFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.ArtifactRefused });
      expect((yield* artifacts.update({ id: blank.id, title: "  第 43 周  " })).title).toBe("第 43 周");
      const renamedFailure = yield* Effect.flip(artifacts.update({ id: blank.id, title: " " }));
      expect(renamedFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.ArtifactRefused });
      const deck = yield* artifacts.create(user, { title: "周报", kind: "html", display: "slides", content: page("幻灯片") });
      expect([html.display, deck.display]).toEqual(["page", "slides"]);
      expect((yield* artifacts.update({ id: html.id, display: "slides" })).display).toBe("slides");
      expect((yield* artifacts.get(html.id)).version).toBe(1);
      expect(blank.display).toBeUndefined();
      const shownFailure = yield* Effect.flip(artifacts.update({ id: blank.id, display: "slides" }));
      expect(shownFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.ArtifactRefused });
      const madeFailure = yield* Effect.flip(artifacts.create(user, { title: "笔记", kind: "markdown", display: "slides", content: "# 笔记" }));
      expect(madeFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.ArtifactRefused });
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.effect("takes the user's words in place of some on the page as its next version, over the latest only", () =>
    Effect.gen(function* () {
      const artifacts = yield* Artifact;
      const chat = yield* Channel;
      const source = "<h1>Launch</h1>\n<p>Ship on Friday.</p>\n<script>document.title = 'Friday'</script>";
      const made = yield* artifacts.create(user, { title: "上线", kind: "html", content: source });
      const anchor = { kind: "text" as const, exact: "Friday", prefix: "Ship on ", suffix: "." };
      const next = yield* artifacts.htmlEdit(user, { id: made.id, version: 1, anchor, text: "Monday" });
      expect(next.version).toBe(2);
      expect((yield* artifacts.content(made.id)).content).toBe(source.replace("on Friday", "on Monday"));
      expect((yield* artifacts.content(made.id, 1)).content).toBe(source);
      expect((yield* chat.history(chat.defaultChannel())).at(-1)!.artifact).toMatchObject({ version: 2, note: expect.stringContaining("Monday") });
      const htmlEditFailure = yield* Effect.flip(artifacts.htmlEdit(user, { id: made.id, version: 1, anchor, text: "Sunday" }));
      expect(htmlEditFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.ArtifactRefused });
      const htmlEditFailure2 = yield* Effect.flip(artifacts.htmlEdit(user, { id: made.id, version: 2, anchor, text: "Sunday" }));
      expect(htmlEditFailure2).toMatchObject({ _tag: "ApiError", bizCode: BizCode.ArtifactRefused });
      expect((yield* artifacts.get(made.id)).version).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.effect("refuses what it cannot be, and says which", () =>
    Effect.gen(function* () {
      const artifacts = yield* Artifact;
      const refusedFor = (title: string, kind: string, content: string) => Effect.flip(artifacts.create(user, { title, kind: kind as "html", content }));
      const refusedFor2 = yield* refusedFor("", "html", page("a"));
      expect(refusedFor2).toMatchObject({ _tag: "ApiError", bizCode: BizCode.ArtifactRefused });
      const refusedFor3 = yield* refusedFor("a", "pdf", page("a"));
      expect(refusedFor3).toMatchObject({ _tag: "ApiError", bizCode: BizCode.ArtifactRefused });
      const refusedFor4 = yield* refusedFor("a", "html", "");
      expect(refusedFor4).toMatchObject({ _tag: "ApiError", bizCode: BizCode.ArtifactRefused });
      const refusedFor5 = yield* refusedFor("a", "html", "x".repeat(artifactMax + 1));
      expect(refusedFor5).toMatchObject({ _tag: "ApiError", bizCode: BizCode.ArtifactRefused });
      const versionFailure = yield* Effect.flip(artifacts.version(user, { id: artifactId("nope"), content: "x" }));
      expect(versionFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.ArtifactNotFound });
      const createdFailure = yield* Effect.flip(artifacts.create(user, { title: "a", kind: "html", content: "x", channel: "#nowhere" }));
      expect(createdFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.ChannelNotFound });
      const artifacts2 = yield* artifacts.list({});
      expect(artifacts2).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.effect("goes with its versions, and its pages stay as attachments, each kept once", () =>
    Effect.gen(function* () {
      const artifacts = yield* Artifact;
      const chat = yield* Channel;
      const dir = join((yield* ServerConfig).home, "attachments");
      const pages = () => Arr.filter(readdirSync(dir), (name) => /^[0-9a-f]{64}$/u.test(name));
      const same = page("同一页");
      const one = yield* artifacts.create(user, { title: "一", kind: "html", content: same });
      yield* artifacts.version(user, { id: one.id, content: page("一的第二版") });
      const two = yield* artifacts.create(user, { title: "二", kind: "html", content: same });
      // The same page is one file, whichever artifact keeps it.
      expect(pages().length).toBe(2);
      expect((yield* artifacts.previewRemove(one.id)).does.length).toBeGreaterThan(0);
      yield* artifacts.remove(one.id);
      const artifactFailure = yield* Effect.flip(artifacts.get(one.id));
      expect(artifactFailure).toMatchObject({ _tag: "ApiError", bizCode: BizCode.ArtifactNotFound });
      expect((yield* artifacts.content(two.id)).content).toBe(same);
      yield* artifacts.remove(two.id);
      // Attachments are not deleted with what used them (docs/subsystems/attachment.md).
      expect(pages().length).toBe(2);
      // Its cards stay in the conversation.
      expect((yield* chat.history(chat.defaultChannel())).filter((m) => m.artifact).length).toBe(3);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );
});
