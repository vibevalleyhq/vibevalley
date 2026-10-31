// VibeValley's own agent's memory: MEMORY.md in its home, one line a note, and
// archive/, the folded-away conversation word for word, so a summary that lost a detail can be looked up again.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { memory as memoryWords } from "./prompts.ts";

/** Cut from the top when the prompt carries it: the newest notes matter most. */
const memoryPromptChars = 8_000;

/** Where an agent with this home keeps its memory; the orchestrator page reads it there. */
export const memoryFile = (home: string) => join(home, "MEMORY.md");

/** `- YYYY-MM-DD note`, or whatever the agent wrote when it tidied. id is stable while the line is unchanged. */
export interface MemoryLine {
  readonly id: string;
  readonly text: string;
  readonly date?: string;
}

export interface MemorySnapshot {
  readonly file: string;
  readonly prompt: string;
  readonly lines: MemoryLine[];
  /** How many of the lines the prompt carries. */
  readonly carried: number;
  readonly updatedAt: number;
  readonly lineCount: number;
}

const datedLine = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s*$/u;
const bulletHead = /^[-*]\s+/u;

const lineID = (line: string) => createHash("sha1").update(line.trim()).digest("hex").slice(0, 12);

function memoryLine(line: string): MemoryLine | undefined {
  const text = line.trim();
  if (text === "" || text.startsWith("#")) return undefined;
  const m = datedLine.exec(text);
  return m ? { id: lineID(text), date: m[1]!, text: m[2]! } : { id: lineID(text), text: text.replace(bulletHead, "") };
}

/** updatedAt: the file's modification time, 0 when there is none. */
function snapshotOf(file: string, raw: string, updatedAt: number): MemorySnapshot {
  const text = raw.trim();
  const runes = [...text];
  const cutoff = Math.max(0, runes.length - memoryPromptChars);
  const prompt = cutoff > 0 ? memoryWords.truncatedNote(file) + runes.slice(cutoff).join("") : text;
  const lines: MemoryLine[] = [];
  let carried = 0;
  let offset = 0;
  for (const line of text.split("\n")) {
    const parsed = memoryLine(line);
    if (parsed) {
      lines.push(parsed);
      if (offset >= cutoff) carried++;
    }
    offset += [...line].length + 1;
  }
  return {
    file,
    prompt,
    lines,
    carried,
    updatedAt,
    lineCount: text === "" ? 0 : text.split("\n").length,
  };
}

/** A file's text, none when there is no such file; one that is there and cannot be read is an error. */
const textOf = (path: string) =>
  readFile(path, "utf8").catch((e: unknown) => {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return undefined;
    throw e;
  });

export async function readMemory(home: string): Promise<MemorySnapshot> {
  const file = memoryFile(home);
  const text = await textOf(file);
  if (text === undefined) return snapshotOf(file, "", 0);
  return snapshotOf(file, text, (await stat(file)).mtimeMs);
}

/** MEMORY.md's lines as the model is told them: neither blank nor headings, without their bullet. */
export async function memoryFileLines(home: string): Promise<string[]> {
  return ((await textOf(memoryFile(home))) ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((t) => t !== "" && !t.startsWith("#"))
    .map((t) => t.replace(bulletHead, ""));
}

export async function forgetLine(home: string, id: string) {
  const file = memoryFile(home);
  const text = await textOf(file);
  if (text === undefined) return;
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim() !== "" && lineID(l) === id);
  if (i >= 0) await writeFile(file, [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n"));
}

const localDate = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

export async function remember(home: string, note: string, now: Date): Promise<MemoryLine> {
  await mkdir(home, { recursive: true });
  const line = `- ${localDate(now)} ${note.replace(/\s*\n\s*/gu, " ").trim()}`;
  await appendFile(memoryFile(home), line + "\n");
  return memoryLine(line)!;
}

export async function rewriteMemory(home: string, text: string): Promise<MemorySnapshot> {
  await mkdir(home, { recursive: true });
  const body = text.endsWith("\n") ? text : text + "\n";
  await writeFile(memoryFile(home), body);
  return snapshotOf(memoryFile(home), body, (await stat(memoryFile(home))).mtimeMs);
}

const archiveDir = (home: string) => join(home, "archive");

/** Date.toISOString with its colons and dot made dashes. */
const isoStamp = (now: Date) => now.toISOString().replace(/[:.]/gu, "-");

export async function archive(home: string, session: string, text: string, now: Date): Promise<string> {
  await mkdir(archiveDir(home), { recursive: true });
  const path = join(archiveDir(home), `${session}-${isoStamp(now)}.md`);
  await writeFile(path, text);
  return path;
}

const archiveNames = (home: string) =>
  readdir(archiveDir(home)).then(
    (names) => names.filter((n) => n.endsWith(".md")),
    (): string[] => [],
  );

export interface ArchiveFile {
  readonly name: string;
  readonly at: number;
  readonly chars: number;
}

export interface ArchiveHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export async function archiveFiles(home: string): Promise<ArchiveFile[]> {
  const files = await Promise.all(
    (await archiveNames(home)).map(async (name) => {
      const path = join(archiveDir(home), name);
      const [info, text] = await Promise.all([stat(path), readFile(path, "utf8")]);
      return { name, at: Math.trunc(info.mtimeMs), chars: text.length };
    }),
  );
  return files.toSorted((a, b) => b.at - a.at);
}

/** A name with a path in it is none. */
export async function readArchive(home: string, name: string): Promise<string | undefined> {
  if (name !== basename(name) || !name.endsWith(".md")) return undefined;
  return textOf(join(archiveDir(home), name));
}

/** Any case; 20 hits when limit is 0. */
export async function searchArchive(home: string, query: string, limit = 0): Promise<ArchiveHit[]> {
  const most = limit > 0 ? limit : 20;
  const q = query.trim().toLowerCase();
  const hits: ArchiveHit[] = [];
  if (q === "") return hits;
  for (const file of (await archiveNames(home)).toSorted().toReversed()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- newest first, stopping once enough are found
    const lines = (await readFile(join(archiveDir(home), file), "utf8")).split("\n");
    lines.forEach((l, i) => {
      if (hits.length < most && l.toLowerCase().includes(q))
        hits.push({
          file,
          line: i + 1,
          text: lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join("\n"),
        });
    });
    if (hits.length >= most) break;
  }
  return hits;
}
