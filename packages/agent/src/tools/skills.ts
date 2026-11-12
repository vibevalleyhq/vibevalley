import { homedir } from "node:os";
import { join } from "node:path";

import { mapConcurrent } from "@vibevalley/async";

import { skills as skillWords } from "../base/prompts.ts";
import { AgentFailed, ToolFailed } from "../core/errors.ts";
import { type AgentFs, agentFsOf } from "../infra/fs.ts";

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
  if (!m?.[1]) return out;
  const lines = m[1].split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    const kv = frontMatterKey.exec(lines[i] ?? "");
    const key = kv?.[1];
    if (!kv || !key) continue;
    let value = (kv[2] ?? "").trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && indentedLine.test(lines[i + 1] ?? "")) block.push((lines[++i] ?? "").trim());
      value = block.join(value.startsWith(">") ? " " : "\n");
    }
    const q = quotedValue.exec(value);
    if (q && q[1] === q[3] && q[2] !== undefined) value = q[2];
    out[key] = value;
  }
  return out;
}

export const skillBody = (text: string) => text.replace(frontMatterHead, "").trim();

/** A failure to read (no such folder, not a folder) is none: the skills are what can be read. */
async function orNone<A>(read: () => Promise<A>, none: A): Promise<A> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof AgentFailed) return none;
    throw e;
  }
}

/** One folder's skills, in its order; an unreadable folder or SKILL.md is none. */
async function skillsIn(io: AgentFs, dir: string): Promise<SkillInfo[]> {
  const entries = await orNone<readonly string[]>(() => io.readDir(dir), []);
  const read = await mapConcurrent(entries, 16, async (entry): Promise<SkillInfo | undefined> => {
    if (!(await orNone(async () => (await io.stat(join(dir, entry))).isDirectory, false))) return undefined;
    const path = join(dir, entry, "SKILL.md");
    const data = await orNone<string | undefined>(() => io.readText(path), undefined);
    if (data === undefined) return undefined;
    const fm = frontMatter(data);
    return { name: fm.name || entry, description: fm.description ?? "", path };
  });
  return read.filter((s): s is SkillInfo => s !== undefined);
}

/** The first of a name wins. Unreadable folders are skipped. */
export async function scanSkills(dirs: readonly string[], fs?: AgentFs): Promise<SkillInfo[]> {
  const io = agentFsOf(fs);
  const groups = await Promise.all(dirs.map((dir) => skillsIn(io, dir)));
  const found = new Map<string, SkillInfo>();
  for (const skills of groups) for (const s of skills) if (!found.has(s.name)) found.set(s.name, s);
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

/** Throws a ToolFailed when there is no such skill or its file cannot be read. */
export async function readSkill(skills: readonly SkillInfo[], name: string, fs?: AgentFs): Promise<string> {
  const s = skills.find((x) => x.name === name);
  if (!s)
    throw new ToolFailed(
      skillWords.noSuchSkill(
        name,
        skills.map((x) => x.name),
      ),
    );
  let data: string;
  try {
    data = await agentFsOf(fs).readText(s.path);
  } catch (cause) {
    throw new ToolFailed(skillWords.cannotRead(s.path), cause);
  }
  return skillWords.body(s.name, s.path, skillBody(data));
}
