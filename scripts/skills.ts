/**
 * The project's skills in .agents/skills: each folder has a SKILL.md whose frontmatter `name` is the folder's name and
 * whose `description` is not empty; acceptance's SKILL.md and each of its parts (the other .md files beside it) have the
 * fixed sections create-verification-skill asks for, and its table lists every part and nothing else; the README's table
 * lists every skill and nothing else; .claude/skills links to .agents/skills, so Claude Code
 * and Codex read the same files. Run as part of `vp run docs:verify`; anything wrong exits 1.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dir = resolve(root, ".agents/skills");

const SECTIONS = ["## 什么时候用", "## 准备", "## 步骤", "## 证据", "## 出错时", "## 收拾"];
const ACCEPTANCE = "acceptance";

const errors: string[] = [];

const sectioned = (file: string, text: string) => {
  const headings = new Set(text.split("\n").filter((line) => line.startsWith("## ")));
  for (const section of SECTIONS) if (!headings.has(section)) errors.push(`${file}: missing section "${section}"`);
};

const link = resolve(root, ".claude/skills");
if (!existsSync(link) || !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== "../.agents/skills") {
  errors.push(".claude/skills should be a symlink to ../.agents/skills");
}

const skills = readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .toSorted();

for (const name of skills) {
  const file = `.agents/skills/${name}/SKILL.md`;
  if (!existsSync(resolve(root, file))) {
    errors.push(`${file} is missing`);
    continue;
  }
  const text = readFileSync(resolve(root, file), "utf8");
  const front = /^---\n([\s\S]*?)\n---\n/u.exec(text)?.[1];
  if (front === undefined) {
    errors.push(`${file}: no frontmatter`);
    continue;
  }
  const field = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, "mu").exec(front)?.[1]?.trim() ?? "";
  if (field("name") !== name) errors.push(`${file}: name should be ${name}, is "${field("name")}"`);
  if (field("description") === "") errors.push(`${file}: description is empty`);
  if (name === ACCEPTANCE) {
    sectioned(file, text);
    const parts = readdirSync(resolve(dir, name))
      .filter((f) => f.endsWith(".md") && f !== "SKILL.md")
      .toSorted();
    for (const part of parts) sectioned(`.agents/skills/${name}/${part}`, readFileSync(resolve(dir, name, part), "utf8"));
    // Only the table's rows route: a part linked from prose elsewhere in the entry is not in the table for it.
    const rows = text
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .join("\n");
    const routed = [...rows.matchAll(/\]\(\.agents\/skills\/acceptance\/([\w-]+\.md)\)/gu)].map((m) => m[1] ?? "");
    for (const part of parts) if (!routed.includes(part)) errors.push(`${file} does not route to ${part}`);
    for (const part of routed) if (!parts.includes(part)) errors.push(`${file} routes to ${part}, which is not there`);
  }
}
if (!skills.includes(ACCEPTANCE)) errors.push(`.agents/skills/${ACCEPTANCE} is missing`);

const readme = readFileSync(resolve(dir, "README.md"), "utf8");
const listed = [...readme.matchAll(/\]\(\.agents\/skills\/([\w-]+)\/SKILL\.md\)/gu)].map((m) => m[1] ?? "");
for (const name of skills) if (!listed.includes(name)) errors.push(`.agents/skills/README.md does not list ${name}`);
for (const name of listed) if (!skills.includes(name)) errors.push(`.agents/skills/README.md lists ${name}, which has no folder`);

for (const e of errors) console.error(`skills: ${e}`);
if (errors.length > 0) process.exit(1);
console.log(`skills: ${skills.length} skills ok`);
