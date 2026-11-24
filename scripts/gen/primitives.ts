import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { parseSync } from "vite";

const root = join(import.meta.dirname, "../..");
const out = join(root, "docs/reference/primitives.md");

/** The folders, in the order the page shows them, with what each is for. */
export const folders: readonly { readonly dir: string; readonly what: string }[] = [
  { dir: "packages/protocol/src/rules", what: "规则：服务端和页面都跑的纯函数" },
  { dir: "apps/mac/ui/infra", what: "页面的纯地基、状态中间层与宿主适配" },
];

interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

const isNode = (v: unknown): v is AstNode => typeof v === "object" && v !== null && "type" in v && typeof v.type === "string";
const nodes = (v: unknown): AstNode[] => (Array.isArray(v) ? v.filter(isNode) : []);
const nodeName = (n: unknown): string | undefined =>
  isNode(n) && n.type === "Identifier" && typeof n.name === "string"
    ? n.name
    : isNode(n) && n.type === "Literal" && typeof n.value === "string"
      ? n.value
      : undefined;

/** The values a file declares and exports itself (no types), each with where its export statement starts. */
function exportedValuesOf(path: string, source: string): { readonly name: string; readonly start: number }[] {
  const program: unknown = parseSync(path, source, { lang: path.endsWith(".tsx") ? "tsx" : "ts" }).program;
  if (!isNode(program)) throw new Error(`${path} parsed to no program`);
  const out: { name: string; start: number }[] = [];
  for (const statement of nodes(program.body)) {
    if (statement.type !== "ExportNamedDeclaration" || isNode(statement.source)) continue;
    const d = statement.declaration;
    if (!isNode(d) || d.type === "TSTypeAliasDeclaration" || d.type === "TSInterfaceDeclaration") continue;
    const names = d.type === "VariableDeclaration" ? nodes(d.declarations).map((v) => nodeName(v.id)) : [nodeName(d.id)];
    const start = typeof statement.start === "number" ? statement.start : 0;
    for (const name of names) if (name !== undefined) out.push({ name, start });
  }
  return out;
}

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
    "由 `scripts/gen/primitives.ts` 从各地基文件夹的导出和它们文档注释的第一行写出，不手改；`vp run docs:verify` 查它是不是最新。写一个帮手之前先在这里找一找：已经有的就用，不再写一份。类型不列。",
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
        "docs/reference/primitives.md is not what the shared folders export: an export was added, moved or its doc changed. Fix: vpx scripts/gen/primitives.ts, and look at the diff. See scripts/gen/primitives.ts",
      );
      process.exit(1);
    }
  } else writeFileSync(out, page);
}
