import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { ApiError, BizCode } from "@vibevalley/protocol/api";

import { pkmDir, type ServerConfig } from "#/infra/config.ts";
import { openDb } from "#/infra/db.ts";
import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { testConfig } from "#/testing/layers.ts";

import { makePkm, type Pkm } from "./pkm.ts";

/** The vault over its own database (in memory), closed when the test ends. */
const farm = async (config: ServerConfig = testConfig()) => {
  const log = keptLog();
  const db = await openDb(config, log, wallTime);
  const pkm: Pkm = await makePkm({ config, clock: wallTime, log, db });
  return { pkm, config, [Symbol.asyncDispose]: () => db.close() };
};

/** A file written as another editor would, its time moved on so it reads as changed. */
const edit = async (root: string, file: string, text: string) => {
  const at = join(root, file);
  await mkdir(dirname(at), { recursive: true });
  await writeFile(at, text);
  const later = new Date("2030-01-01T00:00:00.000Z");
  await utimes(at, later, later);
};

const onDisk = (root: string, file: string) => readFile(join(root, file), "utf8");

const isThere = async (root: string, file: string) =>
  stat(join(root, file)).then(
    () => true,
    () => false,
  );

const removed = (root: string, file: string) => rm(join(root, file));

/** What the call was refused with. */
const refusal = async (p: Promise<unknown>): Promise<ApiError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("it was not refused");
};

describe("pkm", () => {
  test("makes a page in its tier's folder, moves it, and reads what another editor wrote", async () => {
    await using f = await farm();
    const { pkm } = f;
    const made = await pkm.save({ title: "Cetus Core", tier: "project", props: { status: "active" }, markdown: "- TODO the parser\n- DOING the editor\n" });
    expect(made.file).toBe("01_Projects/Cetus-Core.md");
    const text = await onDisk(pkm.root, made.file);
    expect(text).toBe("title:: Cetus Core\nstatus:: active\n\n- TODO the parser\n- DOING the editor\n");
    const moved = await pkm.move({ page: "cetus-core", tier: "archive" });
    expect(moved.file).toBe("04_Archives/Cetus-Core.md");
    const there = await isThere(pkm.root, "01_Projects/Cetus-Core.md");
    expect(there).toBe(false);

    const kept = moved.blocks[0]!.id;
    await edit(pkm.root, moved.file, "title:: Cetus Core\nstatus:: active\n\n- NOW written elsewhere\n- TODO the parser\n- DOING the editor\n");
    const view = await pkm.page("Cetus Core");
    expect(view.page.blocks.map((b) => b.body)).toEqual(["written elsewhere", "the parser", "the editor"]);
    expect(view.page.blocks[1]!.id).toBe(kept);
    expect((await pkm.list()).pages.map((p) => [p.slug, p.open])).toEqual([["cetus-core", 3]]);
  });

  test("edits a page by ops, keeps ids across edits and undoes the last change", async () => {
    await using f = await farm();
    const { pkm } = f;
    const page = await pkm.save({ title: "Notes", markdown: "- one\n- two\n" });
    const [one, two] = page.blocks;
    const after = await pkm.apply({
      page: "notes",
      ops: [
        { op: "update", block: one!.id, body: "one, edited" },
        { op: "insert_after", block: one!.id, id: "0193e000-0000-7000-8000-000000000001", body: "between" },
        { op: "indent", block: two!.id },
      ],
    });
    expect(after.blocks.map((b) => [b.id, b.depth, b.body])).toEqual([
      [one!.id, 0, "one, edited"],
      ["0193e000-0000-7000-8000-000000000001", 0, "between"],
      [two!.id, 1, "two"],
    ]);
    expect((await pkm.undo()).undone).toBe(true);
    expect((await pkm.page("notes")).page.blocks.map((b) => b.body)).toEqual(["one", "two"]);
    const undo2 = await pkm.undo();
    expect(undo2).toEqual({ undone: true, page: "notes", what: "save" });
    const there2 = await isThere(pkm.root, "00_Inbox/Notes.md");
    expect(there2).toBe(false);
    expect((await pkm.list()).pages).toEqual([]);
  });

  test("captures into today's journal, tagged for the inbox", async () => {
    await using f = await farm();
    const { pkm } = f;
    await pkm.capture("call the vet");
    const journal = await pkm.capture("buy milk #inbox");
    expect(journal.tier).toBe("journal");
    expect(journal.blocks.map((b) => [b.marker, b.body])).toEqual([
      ["LATER", "call the vet #inbox"],
      ["LATER", "buy milk #inbox"],
    ]);
    expect((await pkm.search({ marker: "LATER" })).length).toBe(2);
  });

  test("captures an outline: into the journal each top line a LATER for the inbox, onto a page as it is", async () => {
    await using f = await farm();
    const { pkm } = f;
    const journal = await pkm.capture("读完第三章\n  记下两句\nTODO 还书");
    expect(journal.blocks.map((b) => [b.depth, b.marker ?? "", b.body])).toEqual([
      [0, "LATER", "读完第三章 #inbox"],
      [1, "", "记下两句"],
      [0, "TODO", "还书 #inbox"],
    ]);
    await pkm.save({ title: "读书", markdown: "- 书单\n" });
    const page = await pkm.capture("- 《置身事内》\n  - 第四章", undefined, "读书");
    expect(page.blocks.map((b) => [b.depth, b.marker ?? "", b.body])).toEqual([
      [0, "", "书单"],
      [0, "", "《置身事内》"],
      [1, "", "第四章"],
    ]);
    // A page by another name: the closest are named.
    const wrong = await refusal(pkm.capture("x", undefined, "读"));
    expect(wrong).toMatchObject({ name: "ApiError", bizCode: BizCode.PkmNotFound });
    expect(wrong.message).toContain("读书");
  });

  test("a page's file is read as written and written back from its edited text, not over a change made since", async () => {
    await using f = await farm();
    const { pkm } = f;
    await pkm.save({ title: "Garden", markdown: "- bulbs\n  - tomatoes\n" });
    const source = await pkm.source("garden");
    expect(source).toMatchObject({ page: "garden", title: "Garden" });
    expect(source.markdown).toContain("- bulbs");
    const edited = await pkm.sourceUpdate({ page: "garden", markdown: source.markdown.replace("tomatoes", "tomatoes, basil"), updated: source.updated });
    expect(edited.blocks.map((b) => b.body)).toEqual(["bulbs", "tomatoes, basil"]);
    // Read before that write: refused, nothing written.
    const stale = await refusal(pkm.sourceUpdate({ page: "garden", markdown: "- gone\n", updated: source.updated - 1 }));
    expect(stale).toMatchObject({ name: "ApiError", bizCode: BizCode.PkmRefused });
    expect((await pkm.page("garden")).page.blocks.map((b) => b.body)).toEqual(["bulbs", "tomatoes, basil"]);
  });

  test("opens a day's journal, making it with a block to write in when it is not there", async () => {
    await using f = await farm();
    const { pkm } = f;
    const made = await pkm.journal("2026-11-02");
    expect([made.title, made.tier, made.file, made.blocks.map((b) => b.body)]).toEqual(["2026_11_02", "journal", "journals/2026_11_02.md", [""]]);
    const again = await pkm.journal("2026-11-02");
    expect(again.blocks.map((b) => b.id)).toEqual(made.blocks.map((b) => b.id));
    expect((await pkm.list()).pages.map((p) => [p.slug, p.day])).toEqual([["2026_11_02", "2026-11-02"]]);
  });

  test("a rewrite keeps the block's links, waits for the user and comes off once accepted", async () => {
    await using f = await farm();
    const { pkm } = f;
    const page = await pkm.save({ title: "Draft", markdown: "- this ==is rough==^[make it read better] about [[Engine]]\n" });
    const block = page.blocks[0]!;
    const remarks = await pkm.comments("draft");
    expect(remarks.map((c) => [c.span, c.body, c.status])).toEqual([["is rough", "make it read better", "open"]]);
    const proposal = await pkm.suggest({ block: block.id, suggested: "a clean sentence" }, "user");
    expect(proposal.restored).toEqual(["[[Engine]]"]);
    expect(proposal.comment).toMatchObject({ id: remarks[0]!.id, status: "suggested", suggested: "a clean sentence [[Engine]]" });
    const accepted = await pkm.resolve({ id: proposal.comment.id, accept: true });
    expect(accepted.blocks[0]!.body).toBe("a clean sentence [[Engine]]");
    const comments2 = await pkm.comments("draft");
    expect(comments2).toEqual([]);
    const text2 = await onDisk(pkm.root, "00_Inbox/Draft.md");
    expect(text2).toBe(`- a clean sentence [[Engine]]\n  id:: ${block.id}\n`);
  });

  test("a block another page refers to keeps its id in its file", async () => {
    await using f = await farm();
    const { pkm } = f;
    const target = await pkm.save({ title: "Ideas", tier: "resource", markdown: "- an idea about engines\n" });
    const id = target.blocks[0]!.id;
    await pkm.save({ title: "Roadmap", tier: "project", markdown: `- builds on ((${id}))\n` });
    const text3 = await onDisk(pkm.root, "03_Resources/Ideas.md");
    expect(text3).toContain(`id:: ${id}`);
    const view = await pkm.page("roadmap");
    expect(view.transclusions).toEqual([{ block: id, found: true, circular: false, page: "ideas", pageTitle: "Ideas", body: "an idea about engines" }]);
    const cluster = await pkm.cluster({ topic: "engines", title: "Engines" });
    expect(cluster.blocks).toEqual([id]);
  });

  test("renames a page and every link to it; merges into one already named so", async () => {
    await using f = await farm();
    const { pkm } = f;
    await pkm.save({ title: "Engine", tier: "resource", markdown: "- what it is\n" });
    await pkm.save({ title: "Log", tier: "journal", markdown: "- read about [[Engine]]\n" });
    const renamed = await pkm.rename({ from: "Engine", to: "Motor" });
    expect(renamed.pages).toEqual(["log"]);
    expect((await pkm.page("motor")).page.props.alias).toBe("Engine");
    expect((await pkm.page("engine")).page.title).toBe("Motor");
    expect((await pkm.page("log")).page.blocks[0]!.body).toBe("read about [[Motor]]");
    await pkm.save({ title: "Turbine", tier: "resource", markdown: "- spins\n" });
    await pkm.rename({ from: "Turbine", to: "Motor" });
    expect((await pkm.page("motor")).page.blocks.map((b) => b.body)).toEqual(["what it is", "spins"]);
    expect((await pkm.list()).pages.map((p) => p.slug).toSorted()).toEqual(["log", "motor"]);
  });

  test("clips a URL once and adds highlights on a second clip", async () => {
    await using f = await farm();
    const { pkm } = f;
    const first = await pkm.clip({
      url: "https://example.com/a/",
      title: "An Article",
      content: "Para one.\n\nPara two.",
      highlights: [{ text: "Para one.", anchor: "p1" }],
    });
    expect(first).toEqual({ duplicate: false, page: "an-article", snapshot: ".pkm/snapshots/An-Article.raw.md" });
    const text4 = await onDisk(pkm.root, first.snapshot);
    expect(text4).toBe("Para one.\n\nPara two.");
    const again = await pkm.clip({ url: "https://example.com/a", title: "Other", content: "", highlights: [{ text: "Para two.", anchor: "p2" }] });
    expect(again.duplicate).toBe(true);
    const view = await pkm.page("an-article");
    expect(view.page.props["source-url"]).toBe("https://example.com/a");
    expect(view.page.blocks.map((b) => b.body)).toEqual([expect.any(String), "> Para one.", "> Para two."]);
    const markdown2 = await pkm.markdown("an-article");
    expect(markdown2).toContain("> Para two.");
  });

  test("searches the blocks through the full-text index, which follows the files", async () => {
    await using f = await farm();
    const { pkm } = f;
    await pkm.save({ title: "解析器", tier: "project", markdown: "- 单遍状态机的解析器\n  - 支持代码块\n- 渲染引擎 rendering engine\n" });
    await pkm.save({ title: "旧方案", tier: "archive", markdown: "- 以前的解析器\n" });
    const found = await pkm.search({ text: "解析器" });
    // The page's title is indexed with each of its blocks; the one whose own words say it is first.
    expect(found[0]!.body).toBe("单遍状态机的解析器");
    expect(found[0]!.children.map((c) => c.body)).toEqual(["支持代码块"]);
    expect(new Set(found.map((h) => h.page))).toEqual(new Set(["解析器", "旧方案"]));
    expect((await pkm.search({ text: "render" })).map((h) => h.body)).toEqual(["渲染引擎 rendering engine"]);
    await removed(pkm.root, "04_Archives/旧方案.md");
    await pkm.list();
    expect(new Set((await pkm.search({ text: "解析器" })).map((h) => h.page))).toEqual(new Set(["解析器"]));
    await edit(pkm.root, "02_Areas/写在外面.md", "- 外面写的解析器笔记\n");
    await pkm.scan();
    expect((await pkm.search({ text: "外面" })).map((h) => h.body)).toEqual(["外面写的解析器笔记"]);
  });

  test("answers for a page that is not there, or whose file is gone", async () => {
    await using f = await farm();
    const { pkm } = f;
    const pageFailure = await refusal(pkm.page("nowhere"));
    expect(pageFailure).toMatchObject({ name: "ApiError", bizCode: BizCode.PkmNotFound });
    await pkm.save({ title: "Gone" });
    await removed(pkm.root, "00_Inbox/Gone.md");
    const pageFailure2 = await refusal(pkm.page("gone"));
    expect(pageFailure2).toMatchObject({ name: "ApiError", bizCode: BizCode.PkmNotFound });
    const savedFailure = await refusal(pkm.save({ title: " " }));
    expect(savedFailure).toMatchObject({ name: "ApiError", bizCode: BizCode.PkmRefused });
    expect(pkmDir(f.config)).toBe(pkm.root);
  });
});
