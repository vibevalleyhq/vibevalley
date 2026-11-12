import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { sleep } from "@vibevalley/async";
import { userId } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";
import { artifactId } from "@vibevalley/protocol/schema";

import { world } from "#/testing/world.ts";

import { artifactMax } from "./policy.ts";

const user = { from: userId, by: userId };
const page = (words: string) => `<!doctype html><title>${words}</title><p>${words}</p>`;

describe("an artifact", () => {
  test("is announced with its card where it belongs, and a new version keeps the old ones readable", async () => {
    await using farm = await world();
    const artifacts = farm.artifact;
    const chat = farm.channel;
    const general = chat.defaultChannel();
    const made = await artifacts.create(user, { title: " 详情：抽屉还是整页 ", kind: "html", content: page("抽屉"), note: "两种" });
    expect(made).toMatchObject({ title: "详情：抽屉还是整页", body: "html", channel: general, by: userId, version: 1 });
    expect(made.versions).toEqual([expect.objectContaining({ version: 1, note: "两种", channel: general, number: expect.any(Number) })]);
    const said = (await chat.history(general)).at(-1)!;
    expect(said.artifact).toEqual({ id: made.id, title: "详情：抽屉还是整页", body: "html", version: 1, note: "两种", display: "page" });
    expect(said.number).toBe(made.versions[0]!.number);

    const next = await artifacts.version(user, { id: made.id, content: page("整页"), note: "加了整页" });
    expect([next.version, next.versions.map((v) => v.version)]).toEqual([2, [1, 2]]);
    expect((await chat.history(general)).at(-1)!.artifact).toMatchObject({ id: made.id, version: 2, note: "加了整页" });
    const content2 = await artifacts.content(made.id);
    expect(content2).toMatchObject({ version: 2, content: page("整页"), body: "html" });
    const content3 = await artifacts.content(made.id, 1);
    expect(content3).toMatchObject({ version: 1, content: page("抽屉") });
    const contentFailure = await artifacts.content(made.id, 3).catch((e: unknown) => e);
    expect(contentFailure).toMatchObject({ bizCode: BizCode.ArtifactNotFound });

    // A later created_at: the channel lists the newest first.
    await sleep(2);
    const forIssue = await artifacts.create(user, { title: "调研", kind: "markdown", content: "# 结论\n\n用抽屉。", issue: "issue-1" });
    expect((await artifacts.list({ issue: "issue-1" })).map((a) => a.id)).toEqual([forIssue.id]);
    expect((await artifacts.list({ channel: general })).map((a) => a.id)).toEqual([forIssue.id, made.id]);
    expect((await artifacts.list({})).length).toBe(2);
  });

  test("handed in as Markdown is read into blocks to write on together, and takes no new version", async () => {
    await using farm = await world();
    const artifacts = farm.artifact;
    const chat = farm.channel;
    const made = await artifacts.create({ from: userId, by: "lab" }, { title: "调研", kind: "markdown", content: "# 结论\n\n用**抽屉**。", note: "初稿" });
    expect(made).toMatchObject({ body: "blocks", version: 0, seq: 1, versions: [] });
    expect((await chat.history(chat.defaultChannel())).at(-1)!.artifact).toEqual({ id: made.id, title: "调研", body: "blocks", version: 0, note: "初稿" });
    const snap = await artifacts.blocks(made.id);
    expect([snap.artifact.id, snap.blocks.map((b) => [b.type, b.updatedBy])]).toEqual([
      made.id,
      [
        ["heading", "lab"],
        ["paragraph", "lab"],
      ],
    ]);
    const content2 = await artifacts.content(made.id);
    expect(content2).toEqual({ version: 1, content: "# 结论\n\n用**抽屉**。\n", body: "blocks" });
    const versionFailure = await artifacts.version(user, { id: made.id, content: "x" }).catch((e: unknown) => e);
    expect(versionFailure).toMatchObject({ bizCode: BizCode.ArtifactRefused });
  });

  test("started on the page with a title is empty and announced nowhere; an html one has no blocks and is shown as a page unless asked", async () => {
    await using farm = await world();
    const artifacts = farm.artifact;
    const chat = farm.channel;
    const before = (await chat.history(chat.defaultChannel())).length;
    const blank = await artifacts.create(user, { title: "周报", kind: "markdown" });
    expect(blank).toMatchObject({ body: "blocks", version: 0, seq: 0, by: userId });
    expect(blank.channel).toBeUndefined();
    expect([(await artifacts.blocks(blank.id)).blocks, (await chat.history(chat.defaultChannel())).length]).toEqual([[], before]);
    const html = await artifacts.create(user, { title: "页", kind: "html", content: page("页") });
    const blocksFailure = await artifacts.blocks(html.id).catch((e: unknown) => e);
    expect(blocksFailure).toMatchObject({ bizCode: BizCode.ArtifactRefused });
    expect((await artifacts.update({ id: blank.id, title: "  第 43 周  " })).title).toBe("第 43 周");
    const renamedFailure = await artifacts.update({ id: blank.id, title: " " }).catch((e: unknown) => e);
    expect(renamedFailure).toMatchObject({ bizCode: BizCode.ArtifactRefused });
    const deck = await artifacts.create(user, { title: "周报", kind: "html", display: "slides", content: page("幻灯片") });
    expect([html.display, deck.display]).toEqual(["page", "slides"]);
    expect((await artifacts.update({ id: html.id, display: "slides" })).display).toBe("slides");
    expect((await artifacts.get(html.id)).version).toBe(1);
    expect(blank.display).toBeUndefined();
    const shownFailure = await artifacts.update({ id: blank.id, display: "slides" }).catch((e: unknown) => e);
    expect(shownFailure).toMatchObject({ bizCode: BizCode.ArtifactRefused });
    const madeFailure = await artifacts.create(user, { title: "笔记", kind: "markdown", display: "slides", content: "# 笔记" }).catch((e: unknown) => e);
    expect(madeFailure).toMatchObject({ bizCode: BizCode.ArtifactRefused });
  });

  test("takes the user's words in place of some on the page as its next version, over the latest only", async () => {
    await using farm = await world();
    const artifacts = farm.artifact;
    const chat = farm.channel;
    const source = "<h1>Launch</h1>\n<p>Ship on Friday.</p>\n<script>document.title = 'Friday'</script>";
    const made = await artifacts.create(user, { title: "上线", kind: "html", content: source });
    const anchor = { kind: "text" as const, exact: "Friday", prefix: "Ship on ", suffix: "." };
    const next = await artifacts.htmlEdit(user, { id: made.id, version: 1, anchor, text: "Monday" });
    expect(next.version).toBe(2);
    expect((await artifacts.content(made.id)).content).toBe(source.replace("on Friday", "on Monday"));
    expect((await artifacts.content(made.id, 1)).content).toBe(source);
    expect((await chat.history(chat.defaultChannel())).at(-1)!.artifact).toMatchObject({ version: 2, note: expect.stringContaining("Monday") });
    const htmlEditFailure = await artifacts.htmlEdit(user, { id: made.id, version: 1, anchor, text: "Sunday" }).catch((e: unknown) => e);
    expect(htmlEditFailure).toMatchObject({ bizCode: BizCode.ArtifactRefused });
    const htmlEditFailure2 = await artifacts.htmlEdit(user, { id: made.id, version: 2, anchor, text: "Sunday" }).catch((e: unknown) => e);
    expect(htmlEditFailure2).toMatchObject({ bizCode: BizCode.ArtifactRefused });
    expect((await artifacts.get(made.id)).version).toBe(2);
  });

  test("refuses what it cannot be, and says which", async () => {
    await using farm = await world();
    const artifacts = farm.artifact;
    const refusedFor = (title: string, kind: string, content: string) =>
      artifacts.create(user, { title, kind: kind as "html", content }).catch((e: unknown) => e);
    const refusedFor2 = await refusedFor("", "html", page("a"));
    expect(refusedFor2).toMatchObject({ bizCode: BizCode.ArtifactRefused });
    const refusedFor3 = await refusedFor("a", "pdf", page("a"));
    expect(refusedFor3).toMatchObject({ bizCode: BizCode.ArtifactRefused });
    const refusedFor4 = await refusedFor("a", "html", "");
    expect(refusedFor4).toMatchObject({ bizCode: BizCode.ArtifactRefused });
    const refusedFor5 = await refusedFor("a", "html", "x".repeat(artifactMax + 1));
    expect(refusedFor5).toMatchObject({ bizCode: BizCode.ArtifactRefused });
    const versionFailure = await artifacts.version(user, { id: artifactId("nope"), content: "x" }).catch((e: unknown) => e);
    expect(versionFailure).toMatchObject({ bizCode: BizCode.ArtifactNotFound });
    const createdFailure = await artifacts.create(user, { title: "a", kind: "html", content: "x", channel: "#nowhere" }).catch((e: unknown) => e);
    expect(createdFailure).toMatchObject({ bizCode: BizCode.ChannelNotFound });
    const artifacts2 = await artifacts.list({});
    expect(artifacts2).toEqual([]);
  });

  test("goes with its versions, and its pages stay as attachments, each kept once", async () => {
    await using farm = await world();
    const artifacts = farm.artifact;
    const chat = farm.channel;
    const dir = join(farm.config.home, "attachments");
    const pages = () => readdirSync(dir).filter((name) => /^[0-9a-f]{64}$/u.test(name));
    const same = page("同一页");
    const one = await artifacts.create(user, { title: "一", kind: "html", content: same });
    await artifacts.version(user, { id: one.id, content: page("一的第二版") });
    const two = await artifacts.create(user, { title: "二", kind: "html", content: same });
    // The same page is one file, whichever artifact keeps it.
    expect(pages().length).toBe(2);
    expect((await artifacts.previewRemove(one.id)).does.length).toBeGreaterThan(0);
    await artifacts.remove(one.id);
    const artifactFailure = await artifacts.get(one.id).catch((e: unknown) => e);
    expect(artifactFailure).toMatchObject({ bizCode: BizCode.ArtifactNotFound });
    expect((await artifacts.content(two.id)).content).toBe(same);
    await artifacts.remove(two.id);
    // Attachments are not deleted with what used them (docs/subsystems/attachment.md).
    expect(pages().length).toBe(2);
    // Its cards stay in the conversation.
    expect((await chat.history(chat.defaultChannel())).filter((m) => m.artifact).length).toBe(3);
  });
});
