// The system prompt lists only names and when-to-use; the body is read when the model asks for it (load_skill), so a
// hundred skills cost a hundred lines, not a hundred files.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { skills as skillWords } from "./prompts.ts";

export interface SkillInfo {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

export const defaultSkillDirs = (cwd: string) => [join(homedir(), ".agents", "skills"), join(homedir(), ".claude", "skills"), join(cwd, ".agents", "skills")];

const frontMatterBlock = /^---\r?\n([\s\S]*?)\r?\n---/;
const frontMatterKey = /^([A-Za-z_][\w-]*):\s*(.*)$/;
const indentedLine = /^\s+\S/;
const quotedValue = /^(['"])([\s\S]*)(['"])$/;
const frontMatterHead = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** YAML's simple `key: value` lines only (quotes and folded `>` allowed). */
export function frontMatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = frontMatterBlock.exec(text);
  if (!m || !m[1]) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = frontMatterKey.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && indentedLine.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
      value = block.join(value.startsWith(">") ? " " : "\n");
    }
    const q = quotedValue.exec(value);
    if (q && q[1] === q[3]) value = q[2]!;
    out[kv[1]!] = value;
  }
  return out;
}

export const skillBody = (text: string) => text.replace(frontMatterHead, "").trim();

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The first of a name wins. Unreadable folders are skipped. */
export function scanSkills(dirs: readonly string[]): SkillInfo[] {
  const found = new Map<string, SkillInfo>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!isDir(join(dir, entry))) continue;
      const path = join(dir, entry, "SKILL.md");
      let data: string;
      try {
        data = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const fm = frontMatter(data);
      const name = fm.name || entry;
      if (!found.has(name)) found.set(name, { name, description: fm.description ?? "", path });
    }
  }
  // localeCompare: case folded first.
  return [...found.values()].sort((a, b) => {
    const la = a.name.toLowerCase();
    const lb = b.name.toLowerCase();
    return la !== lb ? (la < lb ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

export function skillIndex(skills: readonly SkillInfo[], max = 160): string {
  return skills
    .map((s) => {
      const r = [...s.description];
      return skillWords.line(s.name, r.length > max ? r.slice(0, max).join("") + "…" : s.description);
    })
    .join("\n");
}

export function readSkill(skills: readonly SkillInfo[], name: string): string {
  const s = skills.find((x) => x.name === name);
  if (!s)
    throw new Error(
      skillWords.noSuchSkill(
        name,
        skills.map((x) => x.name),
      ),
    );
  let data: string;
  try {
    data = readFileSync(s.path, "utf8");
  } catch {
    throw new Error(skillWords.cannotRead(s.path));
  }
  return skillWords.body(s.name, s.path, skillBody(data));
}
