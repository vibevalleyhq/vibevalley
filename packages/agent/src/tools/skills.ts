import { homedir } from "node:os";
import { join } from "node:path";

import { Effect, type FileSystem } from "effect";

import { skills as skillWords } from "../base/prompts.ts";
import { ToolFailed } from "../core/errors.ts";
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

const isDir = (io: AgentFs, path: string): Effect.Effect<boolean> =>
  io.stat(path).pipe(
    Effect.map((s) => s.isDirectory),
    Effect.catchTag("AgentFailed", () => Effect.succeed(false)),
  );

const readText = (io: AgentFs, path: string): Effect.Effect<string | undefined> =>
  io.readText(path).pipe(
    Effect.map((text): string | undefined => text),
    Effect.catchTag("AgentFailed", () => Effect.undefined),
  );

/** One folder's skills, in its order; an unreadable folder or SKILL.md is none. */
const skillsIn = (io: AgentFs, dir: string): Effect.Effect<SkillInfo[]> =>
  Effect.gen(function* () {
    const entries = yield* io.readDir(dir).pipe(Effect.catchTag("AgentFailed", () => Effect.succeed<readonly string[]>([])));
    const read = yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.gen(function* () {
          if (!(yield* isDir(io, join(dir, entry)))) return undefined;
          const path = join(dir, entry, "SKILL.md");
          const data = yield* readText(io, path);
          if (data === undefined) return undefined;
          const fm = frontMatter(data);
          const info: SkillInfo = { name: fm.name || entry, description: fm.description ?? "", path };
          return info;
        }),
      { concurrency: 16 },
    );
    return read.filter((s): s is SkillInfo => s !== undefined);
  });

/** The first of a name wins. Unreadable folders are skipped. */
export const scanSkills = (dirs: readonly string[], fs?: FileSystem.FileSystem): Effect.Effect<SkillInfo[]> =>
  Effect.gen(function* () {
    const io = agentFsOf(fs);
    const groups = yield* Effect.forEach(dirs, (dir) => skillsIn(io, dir), { concurrency: "unbounded" });
    const found = new Map<string, SkillInfo>();
    for (const skills of groups) for (const s of skills) if (!found.has(s.name)) found.set(s.name, s);
    // localeCompare: case folded first.
    return [...found.values()].toSorted((a, b) => {
      const la = a.name.toLowerCase();
      const lb = b.name.toLowerCase();
      return la !== lb ? (la < lb ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  });

export function skillIndex(skills: readonly SkillInfo[], max = 160): string {
  return skills
    .map((s) => {
      const r = [...s.description];
      return skillWords.line(s.name, r.length > max ? r.slice(0, max).join("") + "…" : s.description);
    })
    .join("\n");
}

export const readSkill = (skills: readonly SkillInfo[], name: string, fs?: FileSystem.FileSystem): Effect.Effect<string, ToolFailed> =>
  Effect.gen(function* () {
    const s = skills.find((x) => x.name === name);
    if (!s) {
      return yield* ToolFailed.make({
        message: skillWords.noSuchSkill(
          name,
          skills.map((x) => x.name),
        ),
      });
    }
    const data = yield* agentFsOf(fs)
      .readText(s.path)
      .pipe(Effect.mapError((cause) => ToolFailed.make({ message: skillWords.cannotRead(s.path), cause })));
    return skillWords.body(s.name, s.path, skillBody(data));
  });
