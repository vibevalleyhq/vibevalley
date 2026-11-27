import { readFileSync } from "node:fs";

/** In code points, as the subject is read: a Chinese character counts once. */
export const subjectMax = 100;

// Git writes these itself; their subjects are not ours to shorten.
const generated = /^(Merge |Revert "|fixup! |squash! |amend! )/u;
// An agent's byline, in a trailer or a footer line.
const byline =
  /^(co-authored-by:.*\b(claude|anthropic|codex|openai|copilot|cursor|gemini)\b|.*generated (with|by) .*\b(claude|codex|copilot|cursor|gemini)\b)/iu;

/** The kinds a branch's name starts with: <kind>/<topic>. */
export const branchKinds = ["feat", "fix", "docs", "chore", "refactor", "test"] as const;

/** The pull request template's sections, in its order. */
export const bodySections = ["## What changed", "## Changelog", "## Checks", "## Not verified"] as const;

// ASD-STE100 prose gate on non-quoted PR body text: reject vague buzzwords and filler phrases.
const steRules: readonly { pattern: RegExp; term: string; hint: string }[] = [
  { pattern: /\bseamlessly\b/iu, term: "seamlessly", hint: "state the exact mechanism" },
  { pattern: /\bout of the box\b/iu, term: "out of the box", hint: "use 'by default' or name the config" },
  { pattern: /\bempower(?:s|ed|ing)?\b/iu, term: "empower", hint: "use 'let' or 'allow' with concrete capability" },
  { pattern: /\bappropriately\b/iu, term: "appropriately", hint: "state the exact condition or value" },
  { pattern: /\bsignificantly\b/iu, term: "significantly", hint: "give the measured number or drop the adverb" },
  { pattern: /\bsubstantially\b/iu, term: "substantially", hint: "give the measured number or drop the adverb" },
  { pattern: /\beffortlessly\b/iu, term: "effortlessly", hint: "state the step removed" },
  { pattern: /\brobustly\b/iu, term: "robustly", hint: "name the retry, bound, or fallback" },
  { pattern: /\bit is worth noting\b/iu, term: "it is worth noting", hint: "state the fact directly" },
];

// Chinese is quoted, not written: the interface's own words in 「」, “” or "", and code, logs and paths in backticks.
const quoted = /```[\s\S]*?```|`[^`\n]*`|「[^」]*」|“[^”]*”|"[^"\n]*"|<!--[\s\S]*?-->/gu;
/** The first run of Chinese written outside quotes and code, or undefined. */
function chineseIn(text: string): string | undefined {
  return /\p{Script=Han}[\p{Script=Han}\u3000-\u303f\uff00-\uffef]*/u.exec(text.replace(quoted, " "))?.[0];
}

/** Non-STE buzzwords or filler phrases outside quoted strings and code spans. */
export function steProblems(text: string): string[] {
  const plain = text.replace(quoted, " ");
  const problems: string[] = [];
  for (const rule of steRules) {
    if (rule.pattern.test(plain)) problems.push(`follow STE rules: avoid "${rule.term}" (${rule.hint})`);
  }
  return problems;
}

/** The message as git keeps it: comment lines and everything under the scissors line dropped. */
export function cleaned(message: string): string {
  const lines: string[] = [];
  for (const line of message.split("\n")) {
    if (line.startsWith("# ------------------------ >8 ------------------------")) break;
    if (!line.startsWith("#")) lines.push(line.trimEnd());
  }
  return lines.join("\n").trim();
}

/** What is wrong with a commit message (empty when nothing). */
export function messageProblems(message: string): string[] {
  const lines = cleaned(message).split("\n");
  const subject = lines[0] ?? "";
  if (generated.test(subject)) return [];
  const problems = subjectProblems(subject);
  if (lines.length > 1 && lines[1] !== "") problems.push("leave a blank line between the subject and the body");
  for (const line of lines) if (byline.test(line)) problems.push(`no agent bylines: "${line}"`);
  return problems;
}

/** What is wrong with a subject, or a pull request's title. */
export function subjectProblems(subject: string): string[] {
  if (subject.trim() === "") return ["the subject is empty"];
  const problems: string[] = [];
  const length = [...subject].length;
  if (length > subjectMax)
    problems.push(`the subject is ${length} characters, at most ${subjectMax}: say what it now does in one sentence, the rest goes in the body`);
  if (subject !== subject.trim()) problems.push("the subject starts or ends with spaces");
  if (/[.。]$/u.test(subject)) problems.push("drop the full stop at the end of the subject");
  const chinese = chineseIn(subject);
  if (chinese !== undefined) problems.push(`write the subject in English, quoting the interface's words in 「」: "${chinese}"`);
  return problems;
}

/** What is wrong with a pull request's body: the template's sections, written in STE English. */
export function bodyProblems(body: string): string[] {
  const problems: string[] = [];
  const headings = new Set(body.split(/\r?\n/u).map((line) => line.trim()));
  for (const section of bodySections) if (!headings.has(section)) problems.push(`the body has no "${section}" section`);
  const chinese = chineseIn(body);
  if (chinese !== undefined) problems.push(`write the body in English, quoting the interface's words in 「」 and logs in backticks: "${chinese}"`);
  problems.push(...steProblems(body));
  return problems;
}

/** What is wrong with a branch's name: <kind>/<topic>, the topic in lowercase English words joined by hyphens. */
export function branchProblems(branch: string): string[] {
  const at = /^([^/]+)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(branch);
  if (!at) return [`name the branch <kind>/<topic>, the topic lowercase words joined by hyphens: "${branch}"`];
  if (!(branchKinds as readonly string[]).includes(at[1]!)) return [`a branch's kind is one of ${branchKinds.join(", ")}: "${at[1]}"`];
  return [];
}

if (import.meta.main) {
  const [first, second] = process.argv.slice(2);
  if (first === undefined) throw new Error("usage: commit-msg.ts <message file> | --title <text> | --body <text> | --branch <name>");
  const problems =
    first === "--title"
      ? subjectProblems(second ?? "")
      : first === "--body"
        ? bodyProblems(second ?? "")
        : first === "--branch"
          ? branchProblems(second ?? "")
          : messageProblems(readFileSync(first, "utf8"));
  for (const p of problems) console.error("commit message: " + p);
  if (problems.length > 0) process.exit(1);
}
