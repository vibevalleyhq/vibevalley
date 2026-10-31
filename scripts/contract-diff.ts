// What a change does to the contract, for its reviewer: the lines changed in the places other code stands on (the wire's
// shapes and endpoints, the schema, each service's interface, the golden data), the areas it touches, and how many
// lines of everything there are for each contract line, the review's compression. Printed as Markdown; CI appends it to
// the job's summary (`vpx scripts/contract-diff.ts --base HEAD^1 >> "$GITHUB_STEP_SUMMARY"`).

import { execFileSync } from "node:child_process";

/** A file changed, with its lines added and removed (a binary one counts none). */
export interface Changed {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
}

/** The contract: what other code is written against. */
export const contractKinds: readonly { readonly kind: string; readonly is: (path: string) => boolean }[] = [
  { kind: "protocol", is: (p) => p.startsWith("packages/protocol/src/") && !p.endsWith(".test.ts") },
  { kind: "schema", is: (p) => p === "apps/server/db/migrations/0001_schema.up.sql" || p.startsWith("apps/server/db/queries/") },
  { kind: "golden data", is: (p) => /\/testdata\/.*\.jsonl\.gz$/u.test(p) },
];

/** The area a path is in: an app's or package's folder, its module under apps/server/src or apps/web/src/features. */
export function areaOf(path: string): string {
  const parts = path.split("/");
  if (parts[0] === "apps" && parts[1] === "server" && parts[2] === "src" && parts.length > 4) return `server/${parts[3]}`;
  if (parts[0] === "apps" && parts[1] === "web" && parts[2] === "src" && parts[3] === "features" && parts.length > 5) return `web/${parts[4]}`;
  if (parts[0] === "apps" || parts[0] === "packages") return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? path;
}

/** A service's interface is its Context.Service class: a changed line inside one counts as the contract's. */
export const isServiceLine = (line: string) => /Context\.Service<|^\s+readonly \w+: .*Effect\.Effect</u.test(line);

/** `git diff --numstat` read. */
export function numstatOf(text: string): Changed[] {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [added = "0", removed = "0", ...path] = l.split("\t");
      return { path: path.join("\t"), added: added === "-" ? 0 : Number(added), removed: removed === "-" ? 0 : Number(removed) };
    });
}

export interface Summary {
  readonly total: number;
  readonly contract: { readonly kind: string; readonly lines: number; readonly files: readonly string[] }[];
  readonly areas: readonly string[];
}

/** serviceLines: the changed lines in service interfaces, counted from the diff's text. */
export function summaryOf(changed: readonly Changed[], serviceLines: number): Summary {
  const lines = (c: Changed) => c.added + c.removed;
  const contract = contractKinds.map(({ kind, is }) => {
    const files = changed.filter((c) => is(c.path));
    return { kind, lines: files.reduce((n, c) => n + lines(c), 0), files: files.map((c) => c.path) };
  });
  return {
    total: changed.reduce((n, c) => n + lines(c), 0),
    contract: [...contract, { kind: "service interfaces", lines: serviceLines, files: [] }],
    areas: [...new Set(changed.map((c) => areaOf(c.path)))].toSorted(),
  };
}

export function markdownOf(s: Summary): string {
  const contractLines = s.contract.reduce((n, c) => n + c.lines, 0);
  const ratio = contractLines === 0 ? "no contract lines" : `${(s.total / contractLines).toFixed(1)} lines for each contract line`;
  return [
    "## The contract this change touches",
    "",
    `${s.total} lines changed; ${contractLines} of them in the contract (${ratio}).`,
    "",
    "| Contract | Lines | Files |",
    "|---|---|---|",
    ...s.contract.map((c) => `| ${c.kind} | ${c.lines} | ${c.files.map((f) => `\`${f}\``).join(", ")} |`),
    "",
    `Areas (${s.areas.length}): ${s.areas.map((a) => `\`${a}\``).join(", ")}`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const at = process.argv.indexOf("--base");
  const base = at >= 0 ? process.argv[at + 1]! : "origin/main";
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const changed = numstatOf(git("diff", "--numstat", "--no-renames", base, "HEAD"));
  const serviceLines = git("diff", "--unified=0", base, "HEAD", "--", "apps/server/src")
    .split("\n")
    .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---") && isServiceLine(l.slice(1))).length;
  process.stdout.write(markdownOf(summaryOf(changed, serviceLines)));
}
