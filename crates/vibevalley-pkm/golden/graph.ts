// What packages/pkm's graph.ts says for a small vault. Run
// from the repo root: vpx <this file> crates/vibevalley-pkm/golden
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import * as md from "@vibevalley/pkm/markdown";
import * as outline from "@vibevalley/pkm/outline";
import * as g from "@vibevalley/pkm/graph";
import * as rules from "@vibevalley/protocol/rules";

const R1 = "6a1b2c3d-0000-4000-a000-000000000001";
const R2 = "6a1b2c3d-0000-4000-a000-000000000002";
const files: [string, string, number][] = [
  ["01_Projects/VibeValley__Design.md", `alias:: ep, VibeValley Plan\ntldr:: A **GPU** terminal\ndeadline:: 2026-12-01\n\n- TODO [#A] Draw the [[VibeValley]] farm with #gpu\n  deadline:: 2026-11-01\n  - DOING wire it, see ((${R1}))\n- ## Notes\n  - plain _words_ and \`code\` and [a link](http://x.y)\n- LATER ship\n`, 1_000],
  ["journals/2026_11_13.md", `- 读了 [[VibeValley/Design]] 和 [[Ann|Ann Lee]]，终端 渲染 很快\n  - TODO call about ((deadbeef-0000-4000-a000-00000000dead))\n    deadline:: 2026-10-01\n- DONE gpu notes [[VibeValley/Design|the design]]\n  deadline:: 2026-01-01\n`, 5_000],
  ["02_Areas/VibeValley.md", `status:: active\n\n- the board\n  id:: ${R1}\n  - loops back ((${R2}))\n- other\n  id:: ${R2}\n  - and on ((${R1}))\n`, 3_000],
  ["00_Inbox/clip.md", `source-url:: https://example.com/gpu\n\n- a clip about GPU text\n- see [[vibevalley/design]]\n`, 5_000],
  ["04_Archives/Old.md", `- old link to [[VibeValley/Design|design]]\n- WAITING forever\n`, 200],
  ["03_Resources/终端.md", `- 终端 的 渲染 笔记 [[VibeValley/Design]]\n`, 4_000],
];
const vault = new Map();
for (const [file, text, mtime] of files) {
  const page = md.parse(text, file, mtime);
  vault.set(page.slug, page);
}
const pages = [...vault.values()];
const words = { circular: (id: string) => `(循环 ${id.slice(0, 4)})`, broken: (id: string) => `(断了 ${id.slice(0, 4)})` };
const strip = (v: unknown) => JSON.parse(JSON.stringify(v));

const out = {
  files,
  pageOf: ["vibevalley/design", "VIBEVALLEY/DESIGN", "ep", "VibeValley Plan", "VibeValley", "nope"].map((n) => [n, g.pageOf(vault, n)?.slug ?? null]),
  blockOf: [R1, R2, "nope"].map((id) => {
    const at = g.blockOf(vault, id);
    return [id, at ? { page: at.page.slug, block: at.block } : null];
  }),
  refsInto: [...g.refsInto(vault)].toSorted(),
  transclusions: pages.map((p) => [p.slug, g.transclusions(vault, p, words, [{ block: "x", body: `shown ((${R2}))` }])]),
  backlinks: pages.map((p) => [p.slug, g.backlinks(vault, p.slug)]),
  summaries: pages.map((p) => g.summaryOf(p)),
  wire: pages.map((p) => g.wireOf(p)),
  flat: pages.map((p) => outline.flatBlocks(p.blocks)),
  plainOf: ["see ((" + R1 + ")) and [[Ann|Ann Lee]] ==hi==^[note]", "**b** *i* __u__ _e_ ~~s~~ a*b c_d_e", "# head\n> quote\n1. one | two\n```js\nx\n```"].map((t) => [t, g.plainOf(vault, t)]),
  plainText: ["**a** and **b", "*x\ny*", "a_b_c and __x__", "- item\n  * nested\n10) ten"].map((t) => [t, rules.plainText(t)]),
  queryWords: ["  GPU Render ", "终端渲染 很快", "a.b-c/d_e x"].map((t) => [t, g.queryWords(t)]),
  search: [
    { text: "gpu" },
    { text: "终端 渲染" },
    { text: "design", tier: "journal" },
    { marker: "TODO" },
    { linkedTo: "VibeValley/Design" },
    { text: "the", limit: 2 },
  ].map((req) => [req, strip(g.search(vault, req))]),
  ranked: strip(g.search(vault, { text: "anything" }, new Map([[R1, 3], [R2, 1]]))),
  radar: g.radar(vault, Date.UTC(2026, 10, 13, 12), 7),
  export: pages.map((p) => [p.slug, g.exportMarkdown(vault, p, (t: string) => `> ${t}`)]),
  renamed: pages.map((p) => [p.slug, g.renameLinks(p, "vibevalley/design", "VibeValley/Plan") ?? null]),
  keepLinks: [["a [[X]] and ((" + R1 + "))", "a rewrite"], ["[[ Y ]]", "has [[Y]]"]].map(([o, p]) => g.keepLinks(o, p)),
  clustered: ["gpu", "终端", "nothing"].map((t) => [t, g.clustered(vault, t).map((c: { page: { slug: string }; node: { id: string } }) => [c.page.slug, c.node.id])]),
  clipOf: ["https://example.com/gpu", "https://none"].map((u) => [u, g.clipOf(vault, u)?.slug ?? null]),
};
writeFileSync(join(process.argv[2]!, "graph.json"), JSON.stringify(out, null, 1));
console.log("wrote graph.json");
