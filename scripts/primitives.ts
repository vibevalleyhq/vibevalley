// Writes docs/reference/primitives.md: what the shared folders export (the server's base and infra, its test farm, the
// page's base, infra and state, the protocol's rules, the test kit), each with the first line of its doc comment, so a
// change looks there before it writes a helper again. Read from the syntax tree; --check fails when the file is not
// what the folders say (docs:verify runs it).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { exportedValuesOf } from "../packages/testkit/src/source.ts";

const root = join(import.meta.dirname, "..");
const out = join(root, "docs/reference/primitives.md");

/** The folders, in the order the page shows them, with what each is for. */
export const folders: readonly { readonly dir: string; readonly what: string }[] = [
  { dir: "packages/protocol/src/rules", what: "规则：服务端和页面都跑的纯函数" },
  { dir: "apps/server/src/base", what: "服务端的纯地基：id、JSON、文字、脱敏" },
  { dir: "apps/server/src/infra", what: "服务端对外的地基：配置、库、文件、时间、日志" },
  { dir: "apps/server/src/testing", what: "服务端测试的农场：世界、git、帮工、时钟" },
  { dir: "apps/web/src/base", what: "页面的纯地基" },
  { dir: "apps/web/src/infra", what: "页面对外的地基：服务端、宿主、浏览器" },
  { dir: "apps/web/src/state", what: "页面的中间层：意图、存下的选择、原子" },
  { dir: "packages/testkit/src", what: "测试共用：等待、黄金数据、金字塔、语法树" },
];

export interface Primitive {
  readonly name: string;
  readonly file: string;
  /** The first line of its doc comment, "" when it has none. */
  readonly doc: string;
}

/** The doc comment right before position, its first sentence's line. */
function docBefore(source: string, position: number): string {
  const before = source.slice(0, position).trimEnd();
  if (!before.endsWith("*/")) return "";
  const open = before.lastIndexOf("/**");
  if (open < 0) return "";
  return (
    before
      .slice(open + 3, -2)
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/u, "").trim())
      .find((l) => l !== "") ?? ""
  );
}

/** What a file exports by name, with the doc comment of each. */
export const primitivesOf = (file: string, source: string): Primitive[] =>
  exportedValuesOf(file, source).map(({ name, start }) => ({ name, file, doc: docBefore(source, start) }));

const filesIn = (dir: string): string[] =>
  readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/u.test(f) && !/\.(test|spec|stories)\.tsx?$/u.test(f))
    .map((f) => join(dir, f).split("\\").join("/"))
    .toSorted();

export function primitivesPage(): string {
  const lines = [
    "# 共用的原语",
    "",
    "由 `scripts/primitives.ts` 从各地基文件夹的导出和它们文档注释的第一行写出，不手改；`vp run docs:verify` 查它是不是最新。写一个帮手之前先在这里找一找：已经有的就用，不再写一份。类型不列。",
    "",
  ];
  for (const { dir, what } of folders) {
    lines.push(`## \`${dir}\``, "", what, "", "| 名字 | 文件 | 说的是 |", "|---|---|---|");
    for (const file of filesIn(dir))
      for (const p of primitivesOf(file, readFileSync(join(root, file), "utf8")))
        lines.push(`| \`${p.name}\` | \`${relative(dir, p.file)}\` | ${p.doc.replaceAll("|", "\\|")} |`);
    lines.push("");
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const page = primitivesPage();
  if (process.argv.includes("--check")) {
    if (readFileSync(out, "utf8") !== page) {
      console.error(
        "docs/reference/primitives.md is not what the shared folders export: an export was added, moved or its doc changed. Fix: vpx scripts/primitives.ts, and look at the diff. See scripts/primitives.ts",
      );
      process.exit(1);
    }
  } else writeFileSync(out, page);
}
