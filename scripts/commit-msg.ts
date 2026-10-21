/**
 * What a commit message must be (docs/development.md#分支提交和-pr). The commit-msg hook runs it on the message file;
 * CI runs it on a pull request's title, which squash merging makes the commit's subject.
 *
 *   pnpm exec tsx scripts/commit-msg.ts <message file>
 *   pnpm exec tsx scripts/commit-msg.ts --title <text>
 */

import { readFileSync } from "node:fs";

/** In code points, as the subject is read: a Chinese character counts once. */
export const subjectMax = 100;

// Git writes these itself; their subjects are not ours to shorten.
const generated = /^(Merge |Revert "|fixup! |squash! |amend! )/;
// An agent's byline, in a trailer or a footer line.
const byline =
  /^(co-authored-by:.*\b(claude|anthropic|codex|openai|copilot|cursor|gemini)\b|.*generated (with|by) .*\b(claude|codex|copilot|cursor|gemini)\b)/i;

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
  if (/[.。]$/.test(subject)) problems.push("drop the full stop at the end of the subject");
  return problems;
}

if (import.meta.main) {
  const [first, second] = process.argv.slice(2);
  if (first === undefined) throw new Error("usage: commit-msg.ts <message file> | --title <text>");
  const problems = first === "--title" ? subjectProblems(second ?? "") : messageProblems(readFileSync(first, "utf8"));
  for (const p of problems) console.error("commit message: " + p);
  if (problems.length > 0) process.exit(1);
}
