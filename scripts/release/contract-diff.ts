import { execFileSync } from "node:child_process";

/** A file changed, with its lines added and removed (a binary one counts none). */
export interface Changed {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
}

/** The contract: what other code is written against. */
export const contractKinds: readonly { readonly kind: string; readonly is: (path: string) => boolean }[] = [
  {
    kind: "protocol",
    is: (p) => p.startsWith("crates/protocol/src/contract/") || (p.startsWith("packages/protocol/src/") && !p.endsWith(".test.ts") && !p.endsWith(".gen.ts")),
  },
  {
    kind: "schema",
    is: (p) => p === "crates/server/src/base/db.rs" || (p.startsWith("crates/server/src/modules/") && p.endsWith("store.rs")),
  },
];

/** The area a path is in: a crate, an app or package's folder, a server module or a UI feature. */
export function areaOf(path: string): string {
  const parts = path.split("/");
  if (parts[0] === "crates" && parts[1] === "server" && parts[2] === "src" && parts[3] === "modules") {
    const modName = parts[5] && parts[5] !== "mod.rs" ? parts[5] : parts[4];
    if (modName && modName !== "mod.rs") return `server/${modName.replace(/\.rs$/u, "")}`;
  }
  if (parts[0] === "apps" && parts[1] === "mac" && parts[2] === "ui" && parts[3] === "features" && parts.length > 4) return `mac/${parts[4]}`;
  if (parts[0] === "crates" || parts[0] === "apps" || parts[0] === "packages") return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? path;
}

/** A service's public boundary line in `crates/server/src/transport/api` or a server module. */
export const isServiceLine = (line: string) => /^\s*pub (?:trait|fn) \w+/u.test(line);

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
  const serviceLines = git("diff", "--unified=0", base, "HEAD", "--", "crates/server/src/transport/api", "crates/server/src/modules")
    .split("\n")
    .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---") && isServiceLine(l.slice(1))).length;
  process.stdout.write(markdownOf(summaryOf(changed, serviceLines)));
}
