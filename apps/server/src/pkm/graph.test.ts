import { describe, expect, it } from "vite-plus/test";

import { backlinks, exportMarkdown, keepLinks, pageOf, radar, renameLinks, search, transclusions, type Vault } from "./graph.ts";
import { applyOps } from "./ops.ts";
import { flatten, type Page, parse, print } from "./outline.ts";

const day = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 3, 4);

const vaultOf = (files: Record<string, string>, mtime = now): Vault => {
  const pages = new Map<string, Page>();
  for (const [file, text] of Object.entries(files)) {
    const page = parse(text, file, mtime);
    pages.set(page.slug, page);
  }
  return pages;
};

const ref = "aaaaaaaa-0000-4000-a000-000000000001";
const loop = "bbbbbbbb-0000-4000-a000-000000000002";

const files = {
  "01_Projects/Cetus.md": `alias:: Whale\ndeadline:: 2026-11-15\n\n- TODO ship the parser [[Engine]]\n  deadline:: 2026-11-01\n- DOING the editor\n- the core idea\n  id:: ${ref}\n`,
  "journals/2026_11_03.md": `- met about [[Engine]] and ((${ref}))\n  - its notes\n`,
  "03_Resources/Engine.md": `- what an engine is\n- loops ((${loop}))\n  id:: ${loop}\n`,
  "04_Archives/Old.md": "- the old [[Engine]] sketch\n",
  "00_Inbox/Clip.md": "- an engine article\n",
};

describe("the vault's pages together", () => {
  it("finds a page by slug, title or alias", () => {
    const v = vaultOf(files);
    expect(pageOf(v, "cetus")?.title).toBe("Cetus");
    expect(pageOf(v, "WHALE")?.title).toBe("Cetus");
    expect(pageOf(v, "nothing")).toBeUndefined();
  });

  it("reads refs out, never in a circle, and says a missing one", () => {
    const v = vaultOf({ ...files, "00_Inbox/Broken.md": "- ((cccccccc-0000-4000-a000-000000000003))\n" });
    const journal = pageOf(v, "2026_11_03")!;
    expect(transclusions(v, journal, { circular: (id) => `circular ${id}`, broken: (id) => `broken ${id}` })).toEqual([
      { block: ref, found: true, page: "cetus", pageTitle: "Cetus", body: "the core idea" },
    ]);
    const engine = pageOf(v, "engine")!;
    const [self] = transclusions(v, engine, { circular: (id) => `circular ${id}`, broken: (id) => `broken ${id}` });
    expect(self).toMatchObject({ circular: true });
    const [missing] = transclusions(v, pageOf(v, "broken")!, { circular: (id) => id, broken: (id) => `broken ${id}` });
    expect(missing).toMatchObject({ found: false, body: "broken cccccccc-0000-4000-a000-000000000003" });
  });

  it("groups the blocks linking to a page by PARA", () => {
    const links = backlinks(vaultOf(files), "engine");
    expect(links.projects.map((l) => l.body)).toEqual(["ship the parser [[Engine]]"]);
    expect(links.journals.map((l) => l.page)).toEqual(["2026_11_03"]);
    expect(links.archives).toHaveLength(1);
    expect(links.areas).toEqual([]);
  });

  it("ranks what is worked on above what is archived, and brings a hit's children", () => {
    const hits = search(vaultOf(files), { text: "engine" });
    expect(hits[0]!.page).toBe("cetus");
    expect(hits.at(-1)!.page).toBe("old");
    const journal = search(vaultOf(files), { text: "met about" })[0]!;
    expect(journal.children.map((c) => c.body)).toEqual(["its notes"]);
    expect(search(vaultOf(files), { marker: "DOING" }).map((h) => h.body)).toEqual(["the editor"]);
    expect(search(vaultOf(files), { linkedTo: "Engine", tier: "archive" }).map((h) => h.page)).toEqual(["old"]);
  });

  it("says the inbox, the stale projects and what is overdue", () => {
    const r = radar(vaultOf(files, now - 20 * day), now, 14);
    expect(r.inbox).toBe(1);
    expect(r.stale).toEqual([{ slug: "cetus", title: "Cetus", days: 20, deadline: "2026-11-15", todo: 1, doing: 1, done: 0 }]);
    expect(r.overdue.map((o) => o.body)).toEqual(["ship the parser [[Engine]]"]);
    expect(radar(vaultOf(files), now, 14).stale).toEqual([]);
  });

  it("says every link to a renamed page by its new name", () => {
    const v = vaultOf(files);
    const renamed = renameLinks(pageOf(v, "old")!, "engine", "Motor")!;
    expect(flatten(renamed.blocks)[0]!.body).toBe("the old [[Motor]] sketch");
    expect(renameLinks(pageOf(v, "clip")!, "engine", "Motor")).toBeUndefined();
  });

  it("exports plain Markdown: refs read out, links as words", () => {
    const v = vaultOf(files);
    expect(exportMarkdown(v, pageOf(v, "2026_11_03")!, (t) => `> ${t}`)).toBe("# 2026_11_03\n\n### met about Engine and the core idea\n\n- its notes\n");
  });

  it("keeps every link a rewrite would drop", () => {
    expect(keepLinks(`see [[A]] and ((${ref}))`, "see A")).toEqual({
      text: `see A [[A]] ((${ref}))`,
      kept: ["[[A]]", `((${ref}))`],
      restored: ["[[A]]", `((${ref}))`],
    });
  });
});

describe("the ops on an outline", () => {
  const blocks = () => parse("- a\n- b\n  - b1\n- c\n", "00_Inbox/x.md", 0).blocks;
  const ids = () => flatten(blocks()).map((b) => b.id);
  const text = (nodes: ReturnType<typeof blocks>) => print({ props: {}, blocks: nodes });
  let n = 0;
  const newId = () => `new-${++n}`;

  it("indents and outdents a block with what is under it", () => {
    const [a, b] = ids();
    expect(text(applyOps(blocks(), [{ op: "indent", block: b! }], newId))).toBe("- a\n  - b\n    - b1\n- c\n");
    expect(text(applyOps(blocks(), [{ op: "indent", block: a! }], newId))).toBe("- a\n- b\n  - b1\n- c\n");
    const b1 = ids()[2]!;
    expect(text(applyOps(blocks(), [{ op: "outdent", block: b1 }], newId))).toBe("- a\n- b\n- b1\n- c\n");
  });

  it("moves, inserts, updates and deletes", () => {
    const [a, b, , c] = ids();
    const ops = [
      { op: "move", block: c!, direction: "up" },
      { op: "insert_after", block: a!, id: "given", body: "after a", marker: "TODO" },
      { op: "insert_child", block: c!, body: "under c" },
      { op: "update", block: b!, body: "B" },
      { op: "toggle_marker", block: a! },
      { op: "delete", block: "nowhere" },
      { op: "append", body: "last" },
    ] as const;
    expect(text(applyOps(blocks(), ops, newId))).toBe("- TODO a\n- TODO after a\n- c\n  - under c\n- B\n  - b1\n- last\n");
  });

  it("cycles a marker and takes it off", () => {
    const [a] = ids();
    const toggled = (times: number) =>
      applyOps(
        blocks(),
        Array.from({ length: times }, () => ({ op: "toggle_marker", block: a! }) as const),
        newId,
      )[0]!.marker;
    expect([toggled(1), toggled(2), toggled(3), toggled(4)]).toEqual(["TODO", "DOING", "DONE", "TODO"]);
    expect(
      applyOps(
        blocks(),
        [
          { op: "set_marker", block: a!, marker: "LATER" },
          { op: "set_marker", block: a! },
        ],
        newId,
      )[0]!.marker,
    ).toBeUndefined();
  });
});
