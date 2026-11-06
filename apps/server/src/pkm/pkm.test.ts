import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { pkmDir, ServerConfig } from "#/infra/config.ts";
import { Database, Db } from "#/infra/db.ts";
import { testConfig } from "#/testing/layers.ts";

import { make, Pkm } from "./pkm.ts";

const farm = (config = testConfig()) =>
  Layer.effect(Pkm, make).pipe(
    Layer.provideMerge(Db.layer),
    Layer.provideMerge(Database),
    Layer.provideMerge(Layer.succeed(ServerConfig, config)),
    Layer.provideMerge(NodeServices.layer),
  );

/** A file written as another editor would, its time moved on so it reads as changed. */
const edit = (root: string, file: string, text: string) => {
  const path = join(root, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  const later = new Date(Date.UTC(2030, 0, 1));
  utimesSync(path, later, later);
};

describe("pkm", () => {
  it.effect("makes a page in its tier's folder, moves it, and reads what another editor wrote", () =>
    Effect.gen(function* () {
      const pkm = yield* Pkm;
      const made = yield* pkm.save({ title: "Cetus Core", tier: "repo", props: { status: "active" }, markdown: "- TODO the parser\n- DOING the editor\n" });
      expect(made.file).toBe("01_Repos/Cetus-Core.md");
      expect(readFileSync(join(pkm.root, made.file), "utf8")).toBe("title:: Cetus Core\nstatus:: active\n\n- TODO the parser\n- DOING the editor\n");
      const moved = yield* pkm.move({ page: "cetus-core", tier: "archive" });
      expect(moved.file).toBe("04_Archives/Cetus-Core.md");
      expect(existsSync(join(pkm.root, "01_Repos/Cetus-Core.md"))).toBe(false);

      const kept = moved.blocks[0]!.id;
      edit(pkm.root, moved.file, "title:: Cetus Core\nstatus:: active\n\n- NOW written elsewhere\n- TODO the parser\n- DOING the editor\n");
      const view = yield* pkm.page("Cetus Core");
      expect(view.page.blocks.map((b) => b.body)).toEqual(["written elsewhere", "the parser", "the editor"]);
      expect(view.page.blocks[1]!.id).toBe(kept);
      expect((yield* pkm.list()).pages.map((p) => [p.slug, p.open])).toEqual([["cetus-core", 3]]);
    }).pipe(Effect.provide(farm())),
  );

  it.effect("edits a page by ops, keeps ids across edits and undoes the last change", () =>
    Effect.gen(function* () {
      const pkm = yield* Pkm;
      const page = yield* pkm.save({ title: "Notes", markdown: "- one\n- two\n" });
      const [one, two] = page.blocks;
      const after = yield* pkm.apply({
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
      expect((yield* pkm.undo()).undone).toBe(true);
      expect((yield* pkm.page("notes")).page.blocks.map((b) => b.body)).toEqual(["one", "two"]);
      expect(yield* pkm.undo()).toEqual({ undone: true, page: "notes", what: "save" });
      expect(existsSync(join(pkm.root, "00_Inbox/Notes.md"))).toBe(false);
      expect((yield* pkm.list()).pages).toEqual([]);
    }).pipe(Effect.provide(farm())),
  );

  it.effect("captures into today's journal, tagged for the inbox", () =>
    Effect.gen(function* () {
      const pkm = yield* Pkm;
      yield* pkm.capture("call the vet");
      const journal = yield* pkm.capture("buy milk #inbox");
      expect(journal.tier).toBe("journal");
      expect(journal.blocks.map((b) => [b.marker, b.body])).toEqual([
        ["LATER", "call the vet #inbox"],
        ["LATER", "buy milk #inbox"],
      ]);
      expect((yield* pkm.search({ marker: "LATER" })).length).toBe(2);
    }).pipe(Effect.provide(farm())),
  );

  it.effect("captures an outline: into the journal each top line a LATER for the inbox, onto a page as it is", () =>
    Effect.gen(function* () {
      const pkm = yield* Pkm;
      const journal = yield* pkm.capture("读完第三章\n  记下两句\nTODO 还书");
      expect(journal.blocks.map((b) => [b.depth, b.marker ?? "", b.body])).toEqual([
        [0, "LATER", "读完第三章 #inbox"],
        [1, "", "记下两句"],
        [0, "TODO", "还书 #inbox"],
      ]);
      yield* pkm.save({ title: "读书", markdown: "- 书单\n" });
      const page = yield* pkm.capture("- 《置身事内》\n  - 第四章", undefined, "读书");
      expect(page.blocks.map((b) => [b.depth, b.marker ?? "", b.body])).toEqual([
        [0, "", "书单"],
        [0, "", "《置身事内》"],
        [1, "", "第四章"],
      ]);
      // A page by another name: the closest are named.
      const wrong = yield* Effect.flip(pkm.capture("x", undefined, "读"));
      expect(wrong).toMatchObject({ _tag: "Missing" });
      expect("what" in wrong ? wrong.what : "").toContain("读书");
    }).pipe(Effect.provide(farm())),
  );

  it.effect("a page's file is read as written and written back from its edited text, not over a change made since", () =>
    Effect.gen(function* () {
      const pkm = yield* Pkm;
      yield* pkm.save({ title: "Garden", markdown: "- bulbs\n  - tomatoes\n" });
      const source = yield* pkm.source("garden");
      expect(source).toMatchObject({ page: "garden", title: "Garden" });
      expect(source.markdown).toContain("- bulbs");
      const edited = yield* pkm.sourceUpdate({ page: "garden", markdown: source.markdown.replace("tomatoes", "tomatoes, basil"), updated: source.updated });
      expect(edited.blocks.map((b) => b.body)).toEqual(["bulbs", "tomatoes, basil"]);
      // Read before that write: refused, nothing written.
      const stale = yield* Effect.flip(pkm.sourceUpdate({ page: "garden", markdown: "- gone\n", updated: source.updated - 1 }));
      expect(stale).toMatchObject({ _tag: "Refused" });
      expect((yield* pkm.page("garden")).page.blocks.map((b) => b.body)).toEqual(["bulbs", "tomatoes, basil"]);
    }).pipe(Effect.provide(farm())),
  );

  it.effect("opens a day's journal, making it with a block to write in when it is not there", () =>
    Effect.gen(function* () {
      const pkm = yield* Pkm;
      const made = yield* pkm.journal("2026-11-02");
      expect([made.title, made.tier, made.file, made.blocks.map((b) => b.body)]).toEqual(["2026_11_02", "journal", "journals/2026_11_02.md", [""]]);
      const again = yield* pkm.journal("2026-11-02");
      expect(again.blocks.map((b) => b.id)).toEqual(made.blocks.map((b) => b.id));
      expect((yield* pkm.list()).pages.map((p) => [p.slug, p.day])).toEqual([["2026_11_02", "2026-11-02"]]);
    }).pipe(Effect.provide(farm())),
  );

  it.effect("a rewrite keeps the block's links, waits for the owner and comes off once accepted", () =>
    Effect.gen(function* () {
      const pkm = yield* Pkm;
      const page = yield* pkm.save({ title: "Draft", markdown: "- this ==is rough==^[make it read better] about [[Engine]]\n" });
      const block = page.blocks[0]!;
      const remarks = yield* pkm.comments("draft");
      expect(remarks.map((c) => [c.span, c.body, c.status])).toEqual([["is rough", "make it read better", "open"]]);
      const proposal = yield* pkm.suggest({ block: block.id, suggested: "a clean sentence" }, "owner");
      expect(proposal.restored).toEqual(["[[Engine]]"]);
      expect(proposal.comment).toMatchObject({ id: remarks[0]!.id, status: "suggested", suggested: "a clean sentence [[Engine]]" });
      const accepted = yield* pkm.resolve({ id: proposal.comment.id, accept: true });
      expect(accepted.blocks[0]!.body).toBe("a clean sentence [[Engine]]");
      expect(yield* pkm.comments("draft")).toEqual([]);
      expect(readFileSync(join(pkm.root, "00_Inbox/Draft.md"), "utf8")).toBe(`- a clean sentence [[Engine]]\n  id:: ${block.id}\n`);
    }).pipe(Effect.provide(farm())),
  );

  it.effect("a block another page refers to keeps its id in its file", () =>
    Effect.gen(function* () {
      const pkm = yield* Pkm;
      const target = yield* pkm.save({ title: "Ideas", tier: "resource", markdown: "- an idea about engines\n" });
      const id = target.blocks[0]!.id;
      yield* pkm.save({ title: "Roadmap", tier: "repo", markdown: `- builds on ((${id}))\n` });
      expect(readFileSync(join(pkm.root, "03_Resources/Ideas.md"), "utf8")).toContain(`id:: ${id}`);
      const view = yield* pkm.page("roadmap");
      expect(view.transclusions).toEqual([{ block: id, found: true, page: "ideas", pageTitle: "Ideas", body: "an idea about engines" }]);
      const cluster = yield* pkm.cluster({ topic: "engines", title: "Engines" });
      expect(cluster.blocks).toEqual([id]);
    }).pipe(Effect.provide(farm())),
  );

  it.effect("renames a page and every link to it; merges into one already named so", () =>
    Effect.gen(function* () {
      const pkm = yield* Pkm;
      yield* pkm.save({ title: "Engine", tier: "resource", markdown: "- what it is\n" });
      yield* pkm.save({ title: "Log", tier: "journal", markdown: "- read about [[Engine]]\n" });
      const renamed = yield* pkm.rename({ from: "Engine", to: "Motor" });
      expect(renamed.pages).toEqual(["log"]);
      expect((yield* pkm.page("motor")).page.props.alias).toBe("Engine");
      expect((yield* pkm.page("engine")).page.title).toBe("Motor");
      expect((yield* pkm.page("log")).page.blocks[0]!.body).toBe("read about [[Motor]]");
      yield* pkm.save({ title: "Turbine", tier: "resource", markdown: "- spins\n" });
      yield* pkm.rename({ from: "Turbine", to: "Motor" });
      expect((yield* pkm.page("motor")).page.blocks.map((b) => b.body)).toEqual(["what it is", "spins"]);
      expect((yield* pkm.list()).pages.map((p) => p.slug).toSorted()).toEqual(["log", "motor"]);
    }).pipe(Effect.provide(farm())),
  );

  it.effect("clips a URL once and adds highlights on a second clip", () =>
    Effect.gen(function* () {
      const pkm = yield* Pkm;
      const first = yield* pkm.clip({
        url: "https://example.com/a/",
        title: "An Article",
        content: "Para one.\n\nPara two.",
        highlights: [{ text: "Para one.", anchor: "p1" }],
      });
      expect(first).toEqual({ duplicate: false, page: "an-article", snapshot: ".pkm/snapshots/An-Article.raw.md" });
      expect(readFileSync(join(pkm.root, first.snapshot), "utf8")).toBe("Para one.\n\nPara two.");
      const again = yield* pkm.clip({ url: "https://example.com/a", title: "Other", content: "", highlights: [{ text: "Para two.", anchor: "p2" }] });
      expect(again.duplicate).toBe(true);
      const view = yield* pkm.page("an-article");
      expect(view.page.props["source-url"]).toBe("https://example.com/a");
      expect(view.page.blocks.map((b) => b.body)).toEqual([expect.any(String), "> Para one.", "> Para two."]);
      expect(yield* pkm.markdown("an-article")).toContain("> Para two.");
    }).pipe(Effect.provide(farm())),
  );

  it.effect("searches the blocks through the full-text index, which follows the files", () =>
    Effect.gen(function* () {
      const pkm = yield* Pkm;
      yield* pkm.save({ title: "解析器", tier: "repo", markdown: "- 单遍状态机的解析器\n  - 支持代码块\n- 渲染引擎 rendering engine\n" });
      yield* pkm.save({ title: "旧方案", tier: "archive", markdown: "- 以前的解析器\n" });
      const found = yield* pkm.search({ text: "解析器" });
      // The page's title is indexed with each of its blocks; the one whose own words say it is first.
      expect(found[0]!.body).toBe("单遍状态机的解析器");
      expect(found[0]!.children.map((c) => c.body)).toEqual(["支持代码块"]);
      expect(new Set(found.map((h) => h.page))).toEqual(new Set(["解析器", "旧方案"]));
      expect((yield* pkm.search({ text: "render" })).map((h) => h.body)).toEqual(["渲染引擎 rendering engine"]);
      rmSync(join(pkm.root, "04_Archives/旧方案.md"));
      yield* pkm.list();
      expect(new Set((yield* pkm.search({ text: "解析器" })).map((h) => h.page))).toEqual(new Set(["解析器"]));
      edit(pkm.root, "02_Areas/写在外面.md", "- 外面写的解析器笔记\n");
      yield* pkm.scan();
      expect((yield* pkm.search({ text: "外面" })).map((h) => h.body)).toEqual(["外面写的解析器笔记"]);
    }).pipe(Effect.provide(farm())),
  );

  it.effect("answers for a page that is not there, or whose file is gone", () =>
    Effect.gen(function* () {
      const pkm = yield* Pkm;
      expect(yield* Effect.flip(pkm.page("nowhere"))).toMatchObject({ _tag: "Missing" });
      yield* pkm.save({ title: "Gone" });
      rmSync(join(pkm.root, "00_Inbox/Gone.md"));
      expect(yield* Effect.flip(pkm.page("gone"))).toMatchObject({ _tag: "Missing" });
      expect(yield* Effect.flip(pkm.save({ title: " " }))).toMatchObject({ _tag: "Refused" });
      expect(pkmDir(yield* ServerConfig)).toBe(pkm.root);
    }).pipe(Effect.provide(farm())),
  );
});
