/**
 * The glossary (docs/README.md 用语), read from its two tables: the words the owner is not told (不用, and the farm's
 * words outside the skins) and the code names its 代码里 column promises. `vpx scripts/i18n.ts check` reads the catalogs
 * against the words; `vpx scripts/glossary.ts` (part of `vp run docs:verify`) looks for every name in the code.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const see = "See docs/README.md 用语";

export interface GlossaryRow {
  /** The word the owner reads (叫法). */
  readonly term: string;
  readonly english: string;
  readonly code: string;
  readonly avoid: string;
  readonly line: number;
}

export interface FarmRow {
  readonly farm: string;
  readonly english: string;
  readonly code: string;
  readonly line: number;
}

export interface Glossary {
  readonly rows: readonly GlossaryRow[];
  readonly farm: readonly FarmRow[];
}

const cellsOf = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/gu, "")
    .split("|")
    .map((c) => c.trim());

/** The table whose header starts with `first`, from the line after its separator to the first line that is not a row. */
function tableAt(lines: readonly string[], from: number, first: string): { cells: string[]; line: number }[] {
  const head = lines.findIndex((l, i) => i >= from && l.startsWith("|") && cellsOf(l)[0] === first);
  if (head < 0) throw new Error(`docs/README.md 用语: no table with the column ${first}`);
  const rows: { cells: string[]; line: number }[] = [];
  for (let i = head + 2; i < lines.length && lines[i]?.startsWith("|") === true; i++) rows.push({ cells: cellsOf(lines[i] ?? ""), line: i + 1 });
  return rows;
}

/** Both tables of the 用语 section; a table that moved or lost a column fails loudly rather than checking nothing. */
export function readGlossary(markdown: string): Glossary {
  const lines = markdown.split("\n");
  const section = lines.findIndex((l) => l.trim() === "## 用语");
  if (section < 0) throw new Error("docs/README.md: no 用语 section");
  const rows = tableAt(lines, section, "叫法").map(({ cells, line }) => {
    if (cells.length !== 5) throw new Error(`docs/README.md:${line}: a 用语 row has ${cells.length} columns, not 5`);
    const [term = "", english = "", code = "", , avoid = ""] = cells;
    return { term, english, code, avoid, line };
  });
  const farm = tableAt(lines, section, "农场里").map(({ cells, line }) => {
    if (cells.length !== 4) throw new Error(`docs/README.md:${line}: a 农场的皮 row has ${cells.length} columns, not 4`);
    const [farmWords = "", english = "", , code = ""] = cells;
    return { farm: farmWords, english, code, line };
  });
  return { rows, farm };
}

const han = /\p{Script=Han}/u;
const qualified = /[（(]/u;
const listed = (cell: string) =>
  cell
    .split("、")
    .map((w) => w.trim())
    .filter((w) => w !== "");

export interface Avoided {
  readonly word: string;
  /** What to say instead, in the catalog's language. */
  readonly use: string;
  readonly line: number;
}

/** The 不用 words of each language. A word with a note in brackets is wrong in one meaning only, so it is the reader's
 * to judge, not this check's, except the note 中文界面: wrong on the Chinese page only. An English word in the English
 * column is that language's word, not an avoided one. */
export function avoidedWords(glossary: Glossary): { readonly zh: Avoided[]; readonly en: Avoided[] } {
  const englishWords = new Set(
    [...glossary.rows.map((r) => r.english), ...glossary.farm.map((r) => r.english)].flatMap((cell) =>
      cell
        .toLowerCase()
        .split(/[^a-z]+/u)
        .filter((w) => w !== ""),
    ),
  );
  const zh: Avoided[] = [];
  const en: Avoided[] = [];
  for (const row of glossary.rows)
    for (const listedWord of listed(row.avoid)) {
      const chineseOnly = listedWord.endsWith("（中文界面）");
      const word = chineseOnly ? listedWord.slice(0, -"（中文界面）".length) : listedWord;
      if (qualified.test(word)) continue;
      zh.push({ word, use: row.term, line: row.line });
      if (!chineseOnly && !han.test(word) && !englishWords.has(word.toLowerCase())) en.push({ word, use: row.english, line: row.line });
    }
  return { zh, en };
}

/** Words that are the farm's in the skin and plain Chinese everywhere else. */
const ordinary: ReadonlySet<string> = new Set([
  // A git repository.
  "仓库",
]);

/** The farm's own words, for the catalogs outside the skins. 农场 names the skin itself, which the workbench may link to
 * (回农场); the system called 农场 is the 不用 of the VibeValley row. */
export function farmWords(glossary: Glossary): Avoided[] {
  return glossary.farm.flatMap((row) =>
    listed(row.farm)
      .map((w) => w.replace(/[（(].*$/u, "").trim())
      .filter((w) => [...w].length >= 2 && han.test(w) && w !== "农场" && !ordinary.has(w))
      .map((word) => ({ word, use: row.code === "" ? row.english : `the workbench's word for ${row.code}`, line: row.line })),
  );
}

/** Namespaces that are a skin: the farm, the memory tree, the pixel pieces they share, the game and the art catalog.
 * The first table is the workbench's words, so a skin says what it likes. */
export const isSkin = (namespace: string) => /^(web\.farm|web\.tree|web\.ui\.pixel|web\.catalog|server\.game)(\.|$)/u.test(namespace);

/** Keys outside a skin's namespace that still speak of the skin: the shortcuts table lists the farm's hotbar keys. */
const skinKeys: ReadonlySet<string> = new Set(["web.base.shortcuts.say.tool", "web.base.shortcuts.say.farmMenu"]);

/** A placeholder's name and an ICU choice's keyword are code, not words ({runtime}, {n, plural, …}). */
const wordsOnly = (text: string) => text.replace(/\{\s*[A-Za-z_]\w*\s*(?:,\s*\w+\s*,?)?/gu, "{");

const hasLatin = (text: string, word: string) => new RegExp(`(?<![A-Za-z])${word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}s?(?![A-Za-z])`, "iu").test(text);

/** Each catalog message that says a word the glossary rules out, in the repository's says form. */
export function wordProblems(glossary: Glossary, locale: "zh" | "en", messages: ReadonlyMap<string, string>): string[] {
  const avoided = avoidedWords(glossary)[locale];
  const farm = locale === "zh" ? farmWords(glossary) : [];
  // A word inside a word the glossary uses (定时 in 定时任务) is that word, not the avoided one.
  const kept = glossary.rows.flatMap((r) => listed(r.term)).toSorted((a, b) => b.length - a.length);
  const problems: string[] = [];
  for (const [key, message] of messages) {
    if (isSkin(key.split(".").slice(0, -1).join(".")) || skinKeys.has(key)) continue;
    let text = wordsOnly(message);
    for (const term of kept) text = text.split(term).join("\u0000".repeat(term.length));
    for (const a of [...avoided, ...farm].toSorted((x, y) => y.word.length - x.word.length)) {
      const found = han.test(a.word) ? text.includes(a.word) : hasLatin(text, a.word);
      if (!found) continue;
      problems.push(`${locale}: ${key} says ${a.word}, which the owner is not told (docs/README.md:${a.line}). Fix: say ${a.use}. ${see}`);
      if (han.test(a.word)) text = text.split(a.word).join("\u0000".repeat(a.word.length));
    }
  }
  return problems;
}

/** The names in `code` cells, each a run of letters, digits and underscores; a file name (`persona.md`) is kept whole. */
export function namesIn(cell: string): { readonly files: string[]; readonly identifiers: string[] } {
  const spans = [...cell.matchAll(/`([^`]+)`/gu)].map((m) => m[1] ?? "");
  const files = spans.filter((s) => /^[\w-]+\.(json|md|ts|tsx|sql)$/u.test(s));
  const identifiers = spans.filter((s) => !files.includes(s)).flatMap((s) => [...s.matchAll(/[A-Za-z_][A-Za-z0-9_]*/gu)].map((m) => m[0]));
  return { files, identifiers: identifiers.filter((id) => id.length >= 2) };
}

/** Each name in a 代码里 column the code no longer has, with the row it is in. */
export function missingNames(glossary: Glossary, hasName: (identifier: string) => boolean, hasFile: (name: string) => boolean): string[] {
  const rows = [
    ...glossary.rows.map((r) => ({ term: r.term, code: r.code, line: r.line })),
    ...glossary.farm.map((r) => ({ term: r.farm, code: r.code, line: r.line })),
  ];
  const problems: string[] = [];
  for (const row of rows) {
    const { files, identifiers } = namesIn(row.code);
    for (const name of [...new Set(identifiers)].filter((n) => !hasName(n)).concat(files.filter((f) => !hasFile(f))))
      problems.push(
        `docs/README.md:${row.line}: ${row.term} says the code calls it ${name}, which no code has. Fix: write the name the code uses now, or bring the name back. ${see}`,
      );
  }
  return problems;
}

/** Where the code names live: the shapes, the server and its queries, the page and the agent. */
const codeDirs = ["packages/protocol/src", "apps/server/src", "apps/server/db/queries", "apps/server/db/migrations", "apps/web/src", "packages/agent/src"];

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  const glossary = readGlossary(readFileSync(resolve(root, "docs/README.md"), "utf8"));
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f !== "" && existsSync(resolve(root, f)));
  const names = new Set<string>();
  for (const file of tracked.filter((f) => codeDirs.some((d) => f.startsWith(d + "/")) && /\.(ts|tsx|sql)$/u.test(f)))
    for (const m of readFileSync(resolve(root, file), "utf8").matchAll(/[A-Za-z_][A-Za-z0-9_]*/gu)) names.add(m[0]);
  const fileNames = new Set(tracked.map((f) => basename(f)));
  const problems = missingNames(
    glossary,
    (n) => names.has(n),
    (f) => fileNames.has(f),
  );
  for (const p of problems) console.error(`glossary: ${p}`);
  if (problems.length > 0) process.exit(1);
  console.log(`glossary: ${glossary.rows.length + glossary.farm.length} rows' code names ok`);
}
