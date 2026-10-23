/**
 * Markdown links in the maintained docs are written from the repository root (`docs/subsystems/issue.md`, never
 * `../subsystems/issue.md` or `/docs/…`) and resolve to a file in the repository, and so does a source path in
 * `inline code` in the current docs and skills (not the Notes, which are history). Run as part of `pnpm run docs:verify`;
 * anything broken exits 1. The document map (`docs/README.md`) links every maintained doc under `docs/`, except itself.
 * External links (http, mailto) are not fetched; `#fragment`s are not checked; links inside code blocks and `inline code`
 * are examples.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const LINK = /\]\(([^)\s]+)\)/g;

/** A path with a folder and a source file's extension; files in the owner's home (`orchestrator/orchestrator.jsonl`) have none of these. */
const CODE_PATH = /`((?:\.\.?\/)*[\w-][\w.-]*\/[\w./-]+\.(?:go|dart|ts|tsx|astro|sql|json|yaml|sh|py|gz))`/g;

/** Tracked and new files: a path may be written from the repository root or from inside a package (`internal/core/core.go`). */
const repoFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\n");
const inRepo = (path: string) => repoFiles.some((f) => (f === path || f.endsWith(`/${path}`)) && existsSync(resolve(root, f)));

/** Every tracked Markdown file except symlinks (.claude/skills points into .agents/skills). */
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => f !== "" && existsSync(resolve(root, f)) && !lstatSync(resolve(root, f)).isSymbolicLink())
  .sort();
function indexCoverageErrors(documents: ReadonlyMap<string, string>): string[] {
  const index = documents.get("docs/README.md");
  if (index === undefined) return ["docs/README.md: missing document map"];
  const linked = new Set([...index.matchAll(LINK)].map((match) => decodeURIComponent((match[1] ?? "").split("#")[0] ?? "")));
  return [...documents.keys()]
    .filter((file) => file !== "docs/README.md" && !linked.has(file))
    .sort()
    .map((file) => `${file}: missing from docs/README.md`);
}

const broken: string[] = [];
for (const file of files) {
  let fenced = false;
  for (const [i, line] of readFileSync(resolve(root, file), "utf8").split("\n").entries()) {
    if (line.startsWith("```")) fenced = !fenced;
    if (fenced) continue;
    // Links inside `inline code` are examples, not links.
    for (const match of line.replace(/`[^`]*`/g, "").matchAll(LINK)) {
      const target = match[1] ?? "";
      if (/^[a-z]+:/.test(target) || target.startsWith("#")) continue;
      const path = decodeURIComponent(target.split("#")[0] ?? "");
      // One spelling per target, whatever file links to it: a moved file is found with one search. A leading slash reads
      // as an absolute path on disk to agents and tools.
      if (/^(\.\.?\/|\/)/.test(path)) {
        broken.push(`${file}:${i + 1}: ${target} (write it from the repository root: ${relative(root, resolve(dirname(resolve(root, file)), path))})`);
        continue;
      }
      const full = resolve(root, path);
      if (!existsSync(full)) broken.push(`${file}:${i + 1}: ${target}`);
      // macOS and Windows find a file whatever the case; Linux and git do not. agents.md is not AGENTS.md.
      else if (realpathSync.native(full) !== realpathSync(full)) broken.push(`${file}:${i + 1}: ${target} (the file is ${realpathSync.native(full)})`);
    }
    // Notes are history: they name files as they were then.
    if (file.startsWith(".agents/notes/")) continue;
    for (const match of line.matchAll(CODE_PATH)) {
      const path = match[1] ?? "";
      if (!inRepo(path.replace(/^(\.\.?\/)+/, "")) && !existsSync(resolve(dirname(resolve(root, file)), path)))
        broken.push(`${file}:${i + 1}: \`${path}\` is not in the repository`);
    }
  }
}
const documents = new Map<string, string>(files.filter((file) => file.startsWith("docs/")).map((file) => [file, readFileSync(resolve(root, file), "utf8")]));
broken.push(...indexCoverageErrors(documents));
for (const b of broken) console.error(`doc links: broken ${b}`);
if (broken.length > 0) process.exit(1);
console.log(`doc links: ${files.length} files ok`);
