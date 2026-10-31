/**
 * Regression tests: the test a fix adds, named `regression: …`, is the one sample of how this code broke. An agent told
 * to make a failing test pass can do it by weakening the test, and nothing else would notice; so a pull request that
 * removes or changes one names it and says why in a `## Regression` section of its body, and a fix/ branch that adds
 * none says why there. CI runs it on a pull request against its base (docs/development.md#分支提交和-pr): the merge
 * commit it checks out has the base as its first parent.
 *
 *   vpx scripts/regression.ts --base <commit> --branch <name> --body <text>
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { parseSync } from "vite";

/** A test's name starts with this when it holds a fix in place. */
export const prefix = "regression: ";

/** The body's section that names each regression test the pull request changed, and why. */
export const section = "## Regression";

const testFile = /\.(test|spec)\.tsx?$/u;
const runners = new Set(["it", "test"]);

type Node = { readonly type?: unknown; readonly start?: number; readonly end?: number; readonly [key: string]: unknown };
const nodeOf = (v: unknown): Node => (typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v)) : {});

/** The test's runner: it(…), test(…), and their members (it.effect, test.skip, it.each(…)(…)). */
function isRunner(callee: Node): boolean {
  if (callee.type === "Identifier") return runners.has(String(callee.name));
  if (callee.type === "MemberExpression") return isRunner(nodeOf(callee.object));
  if (callee.type === "CallExpression") return isRunner(nodeOf(callee.callee));
  return false;
}

function nameOf(arg: Node): string | undefined {
  if (arg.type === "Literal" && typeof arg.value === "string") return arg.value;
  const quasis = Array.isArray(arg.quasis) ? arg.quasis.map(nodeOf) : [];
  if (arg.type === "TemplateLiteral" && quasis.length === 1) return String(nodeOf(quasis[0]?.value).cooked);
  return undefined;
}

/** Each regression test in a file: its name, and its whole call's text (the runner, its options and its body). */
export function regressionTestsIn(path: string, text: string): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== "object" || value === null) return;
    const node = nodeOf(value);
    if (node.type === "CallExpression" && isRunner(nodeOf(node.callee))) {
      const [first] = Array.isArray(node.arguments) ? node.arguments.map(nodeOf) : [];
      const name = first ? nameOf(first) : undefined;
      if (name !== undefined && name.startsWith(prefix)) found.set(name, text.slice(node.start, node.end));
    }
    for (const key in node) if (key !== "parent") visit(node[key]);
  };
  visit(parseSync(path, text, { lang: path.endsWith(".tsx") ? "tsx" : "ts" }).program);
  return found;
}

/** The text of the body's Regression section, up to the next heading. */
function sectionOf(body: string): string | undefined {
  const lines = body.split(/\r?\n/u);
  const at = lines.findIndex((l) => l.trim() === section);
  if (at < 0) return undefined;
  const end = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines.slice(at + 1, end < 0 ? undefined : end).join("\n");
}

/** What is wrong with a pull request's regression tests (empty when nothing). */
export function regressionProblems(a: {
  readonly before: ReadonlyMap<string, string>;
  readonly after: ReadonlyMap<string, string>;
  readonly branch: string;
  readonly body: string;
}): string[] {
  const changed = [...a.before].filter(([name, call]) => a.after.get(name) !== call).map(([name]) => name);
  const added = [...a.after.keys()].filter((name) => !a.before.has(name));
  const said = sectionOf(a.body);
  const problems: string[] = [];
  const unsaid = changed.filter((name) => said === undefined || !said.includes(name));
  if (unsaid.length > 0)
    problems.push(
      `this pull request removes or changes ${unsaid.map((n) => `"${n}"`).join(", ")}: a regression test holds a fix in place, and weakening it lets the bug back. ` +
        `Fix: put the test back as it was and change the code instead; if the behaviour it holds changed on purpose, add a "${section}" section to the body naming each test and why. ` +
        "See docs/development.md",
    );
  if (a.branch.startsWith("fix/") && added.length === 0 && said === undefined)
    problems.push(
      `a fix/ branch adds no test named "${prefix}…", so nothing stops the bug coming back. ` +
        `Fix: add one that fails before the fix and passes after it, named "${prefix}<what stays fixed>"; if no test can hold it (a look checked by a screenshot, packaging, an outside service), add a "${section}" section saying why. ` +
        "See docs/development.md",
    );
  return problems;
}

/** The regression tests in the test files a diff touched, read at one revision. */
function testsAt(rev: string, paths: readonly string[]): Map<string, string> {
  const all = new Map<string, string>();
  for (const path of paths) {
    let text: string;
    try {
      text = execFileSync("git", ["show", `${rev}:${path}`], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // Not there at this revision: added or deleted by the pull request.
      continue;
    }
    for (const [name, call] of regressionTestsIn(path, text)) all.set(name, call);
  }
  return all;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { base: { type: "string" }, branch: { type: "string" }, body: { type: "string" } } });
  if (values.base === undefined || values.branch === undefined || values.body === undefined)
    throw new Error("usage: regression.ts --base <commit> --branch <name> --body <text>");
  const paths = execFileSync("git", ["diff", "--name-only", values.base, "HEAD"], { encoding: "utf8" })
    .split("\n")
    .filter((p) => testFile.test(p));
  const problems = regressionProblems({ before: testsAt(values.base, paths), after: testsAt("HEAD", paths), branch: values.branch, body: values.body });
  for (const p of problems) console.error("regression: " + p);
  if (problems.length > 0) process.exit(1);
}
