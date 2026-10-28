/**
 * Has a model review comments by docs/style/code.md's 注释 section: what a pattern cannot judge (a name said again in
 * other words, an overview, a test telling its steps). scripts/oxlint-plugin.ts's no-comment-divider has the one kind a
 * pattern can. By default only the ones this branch adds, so the cost follows the change; --all takes every comment
 * under the paths given, for clearing out a module. It reports and edits nothing: a wrong delete loses a why
 * (.agents/skills/vv-comments).
 *
 *   vpx scripts/comment-review.ts [--base <ref>] [--dry-run]
 *   vpx scripts/comment-review.ts --all <path>... [--dry-run]
 *
 * The base is where the branch left origin/main; uncommitted changes count. Exits 1 when any comment is not kept.
 * Calls DeepSeek with DEEPSEEK_API_KEY, which costs money; --dry-run counts what it would send.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSync } from "vite";

const root = resolve(import.meta.dirname, "..");

export interface Comment {
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
  readonly text: string;
  /** The lines around it, the comment's own marked with ">". */
  readonly context: string;
}

export type Verdict = "keep" | "delete" | "rewrite";

export interface Finding {
  readonly comment: Comment;
  readonly verdict: Exclude<Verdict, "keep">;
  /** The row of the rule's tables it goes against, as written there. */
  readonly rule: string;
  readonly reason: string;
  /** "" unless verdict is rewrite. */
  readonly rewrite: string;
}

/** Path to the line numbers `git diff -U0` adds there. */
export function addedLines(diff: string): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>();
  let lines: Set<number> | undefined;
  for (const l of diff.split("\n")) {
    const file = /^\+\+\+ b\/(.+)$/.exec(l);
    if (file) added.set(file[1]!, (lines = new Set()));
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (hunk && lines) for (let n = Number(hunk[1]), end = n + Number(hunk[2] ?? 1); n < end; n++) lines.add(n);
  }
  return added;
}

/** What the comment tells a tool, not a reader. */
const directive = /^[*\s]*(@ts-|eslint-|oxlint-|prettier-|@vite-ignore|[#@]__PURE__|@internal\s*$|c8 |v8 |istanbul )/;

/** Its comments, a run of `//` on the lines one after another as one. */
export function commentsIn(file: string, src: string): Comment[] {
  const { comments } = parseSync(file, src, { lang: file.endsWith("x") ? "tsx" : "ts" });
  const lines = src.split("\n");
  const lineAt = (offset: number) => src.slice(0, offset).split("\n").length;
  const runs: { start: number; end: number; line: boolean; directive: boolean }[] = [];
  for (const c of comments) {
    const last = runs.at(-1);
    const isDirective = directive.test(c.value);
    if (last?.line && !last.directive && c.type === "Line" && !isDirective && /^[ \t]*\n[ \t]*$/.test(src.slice(last.end, c.start))) last.end = c.end;
    else runs.push({ start: c.start, end: c.end, line: c.type === "Line", directive: isDirective });
  }
  return runs
    .filter((r) => !r.directive)
    .map(({ start, end }) => {
      const line = lineAt(start);
      const endLine = lineAt(end);
      const from = Math.max(1, line - 3);
      const to = Math.min(lines.length, endLine + 12);
      const context = lines
        .slice(from - 1, to)
        .map((l, i) => (from + i >= line && from + i <= endLine ? "> " : "  ") + l)
        .join("\n");
      return { file, line, endLine, text: src.slice(start, end), context };
    });
}

export const addedComments = (comments: readonly Comment[], added: ReadonlySet<number>): Comment[] =>
  comments.filter((c) => Array.from({ length: c.endLine - c.line + 1 }, (_, i) => c.line + i).some((n) => added.has(n)));

/** docs/style/code.md's 注释 section, as written: the one rule, so the review changes when it does. */
export function rubric(styleDoc: string): string {
  const from = styleDoc.indexOf("\n## 注释");
  if (from < 0) throw new Error("docs/style/code.md has no 注释 section");
  const to = styleDoc.indexOf("\n## ", from + 1);
  return styleDoc.slice(from + 1, to < 0 ? undefined : to).trim();
}

export interface Message {
  readonly role: "system" | "user";
  readonly content: string;
}

export function prompt(rule: string, comments: readonly Comment[]): Message[] {
  const system = `You review code comments in a TypeScript repository, by the repository's rule for comments:

${rule}

For each comment, decide:
- keep: it says something the reader would get wrong without it (a 建议写 row), and says no more than that.
- delete: everything it says the code already says, or it is one of the 不建议写 rows.
- rewrite: it carries something worth keeping, wrapped in what the code already says; give the shorter comment.

Judge the comment against the code it sits on, not its grammar. A comment that names a unit, a range, what null or "" means, an order, a lock, a safety boundary or what must change together is kept even when short.

Answer with a JSON object only: {"verdicts":[{"id":<number>,"verdict":"keep"|"delete"|"rewrite","rule":"<the row of the tables it goes against, as written there; \\"\\" for keep>","reason":"<one short English sentence>","rewrite":"<the comment as it should be, with its // or /** */; \\"\\" unless rewrite>"}]}, one entry for every id.`;
  const user = comments.map((c, i) => `## ${i} ${c.file}:${c.line}\n\n${c.context}`).join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

const verdicts = new Set<string>(["keep", "delete", "rewrite"]);

/** The model's answer for these comments; a missing or malformed verdict is an error, never a keep. */
export function readVerdicts(answer: string, comments: readonly Comment[]): Finding[] {
  const parsed = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, "")) as { verdicts?: unknown };
  if (!Array.isArray(parsed.verdicts)) throw new Error("the answer has no verdicts array");
  const byId = new Map<number, Record<string, unknown>>();
  for (const v of parsed.verdicts as Record<string, unknown>[]) byId.set(Number(v.id), v);
  return comments.flatMap((comment, id) => {
    const v = byId.get(id);
    if (!v) throw new Error(`no verdict for ${comment.file}:${comment.line}`);
    if (typeof v.verdict !== "string" || !verdicts.has(v.verdict)) throw new Error(`${comment.file}:${comment.line}: verdict ${JSON.stringify(v.verdict)}`);
    if (v.verdict === "keep") return [];
    const text = (k: string) => (typeof v[k] === "string" ? v[k] : "");
    return [
      {
        comment,
        verdict: v.verdict as Finding["verdict"],
        rule: text("rule"),
        reason: text("reason"),
        rewrite: v.verdict === "rewrite" ? text("rewrite") : "",
      },
    ];
  });
}

export type Ask = (messages: Message[]) => Promise<string>;

/** Batches of this many: an answer short enough to come back whole, a system prompt sent few times. */
export const batchSize = 20;

export async function review(rule: string, comments: readonly Comment[], ask: Ask, parallel = 4): Promise<Finding[]> {
  const batches = Array.from({ length: Math.ceil(comments.length / batchSize) }, (_, i) => comments.slice(i * batchSize, (i + 1) * batchSize));
  const found: Finding[][] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < batches.length; i = next++) found[i] = readVerdicts(await ask(prompt(rule, batches[i]!)), batches[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(parallel, batches.length) }, worker));
  return found.flat();
}

/** As the farm's orchestrator (packages/ai/src/models.ts). */
const model = "deepseek-flash";

const deepseek =
  (key: string): Ask =>
  async (messages) => {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, response_format: { type: "json_object" } }),
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek answered nothing");
    return content;
  };

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });

/** Where the files are reviewed: lint's, without what tools write. */
const reviewed = (path: string) => /^(apps|packages|scripts)\/.*\.(ts|tsx|mts)$/.test(path) && !/\.d\.ts$|\/db\/generated\/|\/testdata\//.test(path);

if (import.meta.main) {
  const args = process.argv.slice(2);
  const all = args.includes("--all") ? args.slice(args.indexOf("--all") + 1).filter((a) => !a.startsWith("--")) : undefined;
  const at = args.indexOf("--base");
  const base = at >= 0 ? args[at + 1]! : git("merge-base", "HEAD", "origin/main").trim();
  const read = (path: string) => readFileSync(resolve(root, path), "utf8");
  let comments: Comment[];
  if (all) {
    if (all.length === 0) throw new Error("--all takes the paths to review");
    comments = git("ls-files", "--", ...all)
      .split("\n")
      .filter(reviewed)
      .flatMap((path) => commentsIn(path, read(path)));
  } else {
    const added = addedLines(git("diff", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=AMR", base, "--", "apps", "packages", "scripts"));
    for (const path of git("ls-files", "--others", "--exclude-standard", "--", "apps", "packages", "scripts").split("\n").filter(Boolean))
      added.set(
        path,
        new Set(
          read(path)
            .split("\n")
            .map((_, i) => i + 1),
        ),
      );
    comments = [...added].filter(([path]) => reviewed(path)).flatMap(([path, lines]) => addedComments(commentsIn(path, read(path)), lines));
  }
  const what = all ? `under ${all.join(" ")}` : `added since ${base.slice(0, 10)}`;
  const rule = rubric(read("docs/style/code.md"));
  const requests = Math.ceil(comments.length / batchSize);

  if (args.includes("--dry-run")) {
    if (comments.length <= 40) for (const c of comments) console.log(`${c.file}:${c.line}  ${c.text.split("\n")[0]}`);
    else {
      const perFile = new Map<string, number>();
      for (const c of comments) perFile.set(c.file, (perFile.get(c.file) ?? 0) + 1);
      for (const [file, n] of perFile) console.log(`${file}  ${n}`);
    }
    const chars = comments.reduce((n, c) => n + c.context.length, 0) + requests * prompt(rule, [])[0]!.content.length;
    console.log(`\n${comments.length} comments ${what}, in ${requests} requests, about ${chars} characters`);
    process.exit(0);
  }
  if (comments.length === 0) {
    console.log(`no comments ${what}`);
    process.exit(0);
  }
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    console.error("DEEPSEEK_API_KEY is not set (--dry-run counts the comments without it)");
    process.exit(2);
  }
  const findings = await review(rule, comments, deepseek(key));
  for (const f of findings) {
    console.log(`${f.comment.file}:${f.comment.line}  ${f.verdict}  ${f.rule ? f.rule + ": " : ""}${f.reason}`);
    console.log(`    ${f.comment.text.split("\n").join("\n    ")}`);
    if (f.rewrite) console.log(`  → ${f.rewrite.split("\n").join("\n    ")}`);
  }
  console.log(`\n${comments.length} comments ${what}, ${findings.length} not kept`);
  if (findings.length > 0) process.exit(1);
}
