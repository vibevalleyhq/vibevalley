// VibeValley's own agent's memory: MEMORY.md in its home, one line a note, and
// archive/, the folded-away conversation word for word, so a summary that lost a detail can be looked up again.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Cut from the top when the prompt carries it: the newest notes matter most. */
export const memoryPromptChars = 8_000;

/** Where an agent with this home keeps its memory; the manager page reads it there. */
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

const datedLine = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s*$/;
const bulletHead = /^[-*]\s+/;

const lineID = (line: string) => createHash("sha1").update(line.trim()).digest("hex").slice(0, 12);

function memoryLine(line: string): MemoryLine | undefined {
  const text = line.trim();
  if (text === "" || text.startsWith("#")) return undefined;
  const m = datedLine.exec(text);
  return m ? { id: lineID(text), date: m[1]!, text: m[2]! } : { id: lineID(text), text: text.replace(bulletHead, "") };
}

function snapshotOf(file: string, raw: string, updatedAt = Date.now()): MemorySnapshot {
  const text = raw.trim();
  const runes = [...text];
  const cutoff = Math.max(0, runes.length - memoryPromptChars);
  const prompt = cutoff > 0 ? `（更早的记录省略了，全文在 ${file}）\n` + runes.slice(cutoff).join("") : text;
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
  return { file, prompt, lines, carried, updatedAt, lineCount: text === "" ? 0 : text.split("\n").length };
}

export function readMemory(home: string): MemorySnapshot {
  const file = memoryFile(home);
  if (!existsSync(file)) return snapshotOf(file, "");
  return snapshotOf(file, readFileSync(file, "utf8"), statSync(file).mtimeMs);
}

/** MEMORY.md's lines as the model is told them: neither blank nor headings, without their bullet. */
export function memoryFileLines(home: string): string[] {
  const file = memoryFile(home);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((t) => t !== "" && !t.startsWith("#"))
    .map((t) => t.replace(bulletHead, ""));
}

export function forgetLine(home: string, id: string) {
  const file = memoryFile(home);
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split("\n");
  const i = lines.findIndex((l) => l.trim() !== "" && lineID(l) === id);
  if (i >= 0) writeFileSync(file, [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n"));
}

const localDate = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

export function remember(home: string, note: string, now = new Date()): MemoryLine {
  mkdirSync(home, { recursive: true });
  const line = `- ${localDate(now)} ${note.replace(/\s*\n\s*/g, " ").trim()}`;
  appendFileSync(memoryFile(home), line + "\n");
  return memoryLine(line)!;
}

export function rewriteMemory(home: string, text: string): MemorySnapshot {
  mkdirSync(home, { recursive: true });
  const body = text.endsWith("\n") ? text : text + "\n";
  writeFileSync(memoryFile(home), body);
  return snapshotOf(memoryFile(home), body);
}

const archiveDir = (home: string) => join(home, "archive");

/** Date.toISOString with its colons and dot made dashes. */
const isoStamp = (now: Date) => now.toISOString().replace(/[:.]/g, "-");

export function archive(home: string, session: string, text: string, now = new Date()): string {
  mkdirSync(archiveDir(home), { recursive: true });
  const path = join(archiveDir(home), `${session}-${isoStamp(now)}.md`);
  writeFileSync(path, text);
  return path;
}

const archiveNames = (home: string) => (existsSync(archiveDir(home)) ? readdirSync(archiveDir(home)).filter((n) => n.endsWith(".md")) : []);

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

export function archiveFiles(home: string): ArchiveFile[] {
  return archiveNames(home)
    .map((name) => {
      const path = join(archiveDir(home), name);
      return { name, at: Math.trunc(statSync(path).mtimeMs), chars: readFileSync(path, "utf8").length };
    })
    .sort((a, b) => b.at - a.at);
}

/** A name with a path in it is none. */
export function readArchive(home: string, name: string): string | undefined {
  if (name !== basename(name) || !name.endsWith(".md")) return undefined;
  const path = join(archiveDir(home), name);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Any case; 20 hits when limit is 0. */
export function searchArchive(home: string, query: string, limit = 0): ArchiveHit[] {
  const most = limit > 0 ? limit : 20;
  const q = query.trim().toLowerCase();
  const hits: ArchiveHit[] = [];
  if (q === "") return hits;
  for (const file of archiveNames(home).sort().reverse()) {
    const lines = readFileSync(join(archiveDir(home), file), "utf8").split("\n");
    lines.forEach((l, i) => {
      if (hits.length < most && l.toLowerCase().includes(q))
        hits.push({ file, line: i + 1, text: lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join("\n") });
    });
    if (hits.length >= most) break;
  }
  return hits;
}
