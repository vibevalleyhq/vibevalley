/**
 * The project's skills in .agents/skills: each folder has a SKILL.md whose frontmatter `name` is the folder's name and
 * whose `description` is not empty; a verification skill (`verify-*`) has the fixed sections create-verification-skill
 * asks for; the README's table lists every skill and nothing else; .claude/skills links to .agents/skills, so Claude Code
 * and Codex read the same files. Run as part of `bun run docs:verify`; anything wrong exits 1.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dir = resolve(root, ".agents/skills");

const VERIFY_SECTIONS = ["## 什么时候用", "## 准备", "## 步骤", "## 证据", "## 出错时", "## 收拾"];

const errors: string[] = [];

const link = resolve(root, ".claude/skills");
if (!existsSync(link) || !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== "../.agents/skills") {
  errors.push(".claude/skills should be a symlink to ../.agents/skills");
}

const skills = readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

for (const name of skills) {
  const file = `.agents/skills/${name}/SKILL.md`;
  if (!existsSync(resolve(root, file))) {
    errors.push(`${file} is missing`);
    continue;
  }
  const text = readFileSync(resolve(root, file), "utf8");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  if (front === undefined) {
    errors.push(`${file}: no frontmatter`);
    continue;
  }
  const field = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(front)?.[1]?.trim() ?? "";
  if (field("name") !== name) errors.push(`${file}: name should be ${name}, is "${field("name")}"`);
  if (field("description") === "") errors.push(`${file}: description is empty`);
  if (name.startsWith("verify-")) {
    const headings = text.split("\n").filter((line) => line.startsWith("## "));
    for (const section of VERIFY_SECTIONS) if (!headings.includes(section)) errors.push(`${file}: missing section "${section}"`);
  }
}

const readme = readFileSync(resolve(dir, "README.md"), "utf8");
const listed = [...readme.matchAll(/\]\(\.agents\/skills\/([\w-]+)\/SKILL\.md\)/g)].map((m) => m[1] ?? "");
for (const name of skills) if (!listed.includes(name)) errors.push(`.agents/skills/README.md does not list ${name}`);
for (const name of listed) if (!skills.includes(name)) errors.push(`.agents/skills/README.md lists ${name}, which has no folder`);

for (const e of errors) console.error(`skills: ${e}`);
if (errors.length > 0) process.exit(1);
console.log(`skills: ${skills.length} skills ok`);
