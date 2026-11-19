// Writes what packages/pkm says for a set of inputs. Run
// from the repo root: vpx <this file> crates/vibevalley-pkm/golden
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import * as md from "@vibevalley/pkm/markdown";
import * as outline from "@vibevalley/pkm/outline";

const files: Record<string, string> = {
  "01_Projects/VibeValley__Design.md": "title:: VibeValley/Design\ntags:: [[Rust]], #gpu\nzeta:: last\nAlpha:: first\n\n- TODO [#A] Write the spec\n  deadline:: 2026-11-20\n  - DONE port [[VibeValley]] board\n    id:: 6a1b2c3d-0000-4000-a000-000000000001\n  - see ((6a1b2c3d-0000-4000-a000-000000000001)) and #ideas, not C# or issue#12\n- A block with code\n  ```rust\n  - not a bullet\n  id:: not-a-prop\n  ```\n  after the fence\n- ==important words==^[💬 check this] trailing   \n-\n- [#B] priority only\n",
  "journals/2026_11_13.md": "- 写了 [[笔记]] 和 #想法/子话题\n\t- tab indented child\n    - deep child jumps\n- LATER call [[Ann|Ann Lee]]\n  source-url:: [[Links]]\n",
  "00_Inbox/plain.md": "Just text before bullets\n- one\n  two\n\n  three\n",
  "03_Resources/crlf.md": "- a\r\n  - b\r\n",
};
const pages = Object.entries(files).map(([file, text]) => {
  const page = md.parse(text, file, 1);
  return { file, text, page, printed: md.print(page), printedRef: md.print(page, new Set([page.blocks[0]?.id ?? ""])), edges: md.edgesOf(page) };
});

const was = md.parse("- keep me\n- also me\n  - child\n", "00_Inbox/x.md", 1);
const now = md.parse("- new first\n- keep me\n- also me\n  - child\n", "00_Inbox/x.md", 2);
const carried = md.carryIds(was, now);

let n = 0;
const newId = () => `new-${++n}`;
const captured = md.outlineOf("first line\n  - nested\n    deeper\nback out\n* starred", newId);

n = 0;
const base = md.parse("- a\n- b\n  - b1\n- c\n", "00_Inbox/ops.md", 1).blocks;
const id = (i: number) => md.walk(base)[i].id;
const opsCases = [
  [{ op: "append", body: "d" }],
  [{ op: "insert_before", block: id(0), body: "before a", marker: "TODO" }],
  [{ op: "insert_child", block: id(3), body: "c1" }, { op: "indent", block: id(3) }],
  [{ op: "outdent", block: id(2) }],
  [{ op: "toggle_marker", block: id(0) }, { op: "toggle_marker", block: id(0) }, { op: "set_marker", block: id(1), marker: "LATER" }],
  [{ op: "move", block: id(3), direction: "up" }, { op: "delete", block: id(0) }],
  [{ op: "move_to", block: id(0), target: id(2), at: "inside" }],
  [{ op: "move_to", block: id(1), target: id(2), at: "after" }],
  [{ op: "update", block: id(1), body: "B!", priority: "C", props: { deadline: "2026-12-01" } }],
  [{ op: "delete", block: "missing" }],
];
const ops = opsCases.map((o) => ({ ops: o, result: md.applyOps(base, o, newId) }));
const slugs = ["VibeValley/Design", " Two  Words ", "a\\b", "中文 标题"].map((t) => [t, outline.slugOf(t)]);
const tags = ["#a #b/c C# x#y &#38; ## h", "开头#中文 tag"].map((t) => [t, [...t.matchAll(outline.pkmTag)].map((m: RegExpMatchArray) => m[1])]);

writeFileSync(join(process.argv[2]!, "golden.json"), JSON.stringify({ pages, was, now, carried, captured, base, ops, slugs, tags }, null, 1));
console.log("wrote", pages.length, "pages,", ops.length, "op cases");
