// The system prompt lists only names and when-to-use; the body is read when the model asks for it (load_skill), so a
// hundred skills cost a hundred lines, not a hundred files.

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { skills as skillWords } from "./prompts.ts";

export interface SkillInfo {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

export const defaultSkillDirs = (cwd: string) => [join(homedir(), ".agents", "skills"), join(homedir(), ".claude", "skills"), join(cwd, ".agents", "skills")];

const frontMatterBlock = /^---\r?\n([\s\S]*?)\r?\n---/u;
const frontMatterKey = /^([A-Za-z_][\w-]*):\s*(.*)$/u;
const indentedLine = /^\s+\S/u;
const quotedValue = /^(['"])([\s\S]*)(['"])$/u;
const frontMatterHead = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u;

/** YAML's simple `key: value` lines only (quotes and folded `>` allowed). */
export function frontMatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = frontMatterBlock.exec(text);
  if (!m || !m[1]) return out;
  const lines = m[1].split(/\r?\n/u);
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

const isDir = (path: string) =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );

/** One folder's skills, in its order; an unreadable folder or SKILL.md is none. */
const skillsIn = async (dir: string) => {
  const entries = await readdir(dir).catch((): string[] => []);
  const read = await Promise.all(
    entries.map(async (entry) => {
      if (!(await isDir(join(dir, entry)))) return undefined;
      const path = join(dir, entry, "SKILL.md");
      const data = await readFile(path, "utf8").catch((): undefined => undefined);
      if (data === undefined) return undefined;
      const fm = frontMatter(data);
      return { name: fm.name || entry, description: fm.description ?? "", path };
    }),
  );
  return read.filter((s) => s !== undefined);
};

/** The first of a name wins. Unreadable folders are skipped. */
export async function scanSkills(dirs: readonly string[]): Promise<SkillInfo[]> {
  const found = new Map<string, SkillInfo>();
  for (const skills of await Promise.all(dirs.map(skillsIn))) for (const s of skills) if (!found.has(s.name)) found.set(s.name, s);
  // localeCompare: case folded first.
  return [...found.values()].toSorted((a, b) => {
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

export async function readSkill(skills: readonly SkillInfo[], name: string): Promise<string> {
  const s = skills.find((x) => x.name === name);
  if (!s)
    throw new Error(
      skillWords.noSuchSkill(
        name,
        skills.map((x) => x.name),
      ),
    );
  const data = await readFile(s.path, "utf8").catch((): undefined => undefined);
  if (data === undefined) throw new Error(skillWords.cannotRead(s.path));
  return skillWords.body(s.name, s.path, skillBody(data));
}
