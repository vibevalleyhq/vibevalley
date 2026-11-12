import { createHash } from "node:crypto";
import { join } from "node:path";

import { memory as memoryWords } from "../base/prompts.ts";
import { type AgentFs, agentFsOf } from "../infra/fs.ts";
import { type AgentLog, consoleLog } from "../infra/log.ts";

/** Cut from the top when the prompt carries it: the newest notes matter most. */
const memoryPromptChars = 8_000;

/** The standalone agent's file adapter; hosted agents can inject another MemoryPort. */
const memoryFile = (home: string) => join(home, "MEMORY.md");

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

/** read never fails (a memory it cannot read is none, and is logged); remember and rewrite throw an AgentFailed. */
export interface MemoryPort {
  readonly read: () => Promise<{ readonly prompt: string; readonly lines: readonly string[] }>;
  readonly remember: (note: string) => Promise<void>;
  readonly rewrite: (content: string) => Promise<number>;
}

export const fileMemory = (home: string, now: () => number, fs?: AgentFs, log: AgentLog = consoleLog): MemoryPort => ({
  read: async () => {
    try {
      const [snap, lines] = await Promise.all([readMemory(home, fs), memoryFileLines(home, fs)]);
      return { prompt: snap.prompt, lines };
    } catch (e) {
      log.warn(`agent: cannot read memory in ${home}:`, e);
      return { prompt: "", lines: [] };
    }
  },
  remember: async (note) => void (await remember(home, note, now(), fs)),
  rewrite: async (content) => (await rewriteMemory(home, content, fs)).lineCount,
});

export const parseMemoryLines = (text: string): MemoryLine[] =>
  text.split("\n").flatMap((line) => {
    const parsed = memoryLine(line);
    return parsed ? [parsed] : [];
  });

const datedLine = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s*$/u;
const bulletHead = /^[-*]\s+/u;

const lineID = (line: string) => createHash("sha1").update(line.trim()).digest("hex").slice(0, 12);

function memoryLine(line: string): MemoryLine | undefined {
  const text = line.trim();
  if (text === "" || text.startsWith("#")) return undefined;
  const m = datedLine.exec(text);
  return m?.[1] && m[2] ? { id: lineID(text), date: m[1], text: m[2] } : { id: lineID(text), text: text.replace(bulletHead, "") };
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

export async function readMemory(home: string, fs?: AgentFs): Promise<MemorySnapshot> {
  const io = agentFsOf(fs);
  const file = memoryFile(home);
  const text = await io.readTextIfExists(file);
  if (text === undefined) return snapshotOf(file, "", 0);
  const info = await io.stat(file);
  return snapshotOf(file, text, info.mtimeMs);
}

/** MEMORY.md's lines as the model is told them: neither blank nor headings, without their bullet. */
const memoryFileLines = async (home: string, fs?: AgentFs): Promise<string[]> =>
  ((await agentFsOf(fs).readTextIfExists(memoryFile(home))) ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((t) => t !== "" && !t.startsWith("#"))
    .map((t) => t.replace(bulletHead, ""));

export async function forgetLine(home: string, id: string, fs?: AgentFs): Promise<void> {
  const io = agentFsOf(fs);
  const file = memoryFile(home);
  const text = await io.readTextIfExists(file);
  if (text === undefined) return;
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim() !== "" && lineID(l) === id);
  if (i >= 0) await io.writeText(file, [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n"));
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** YYYY-MM-DD where this machine is. */
function localDate(now: number): string {
  const d = new Date(now);
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** now: epoch milliseconds. */
async function remember(home: string, note: string, now: number, fs?: AgentFs): Promise<MemoryLine> {
  const io = agentFsOf(fs);
  await io.makeDir(home);
  const date = localDate(now);
  const cleaned = note.replace(/\s*\n\s*/gu, " ").trim();
  const line = `- ${date} ${cleaned}`;
  await io.appendText(memoryFile(home), line + "\n");
  return { id: lineID(line), date, text: cleaned };
}

async function rewriteMemory(home: string, text: string, fs?: AgentFs): Promise<MemorySnapshot> {
  const io = agentFsOf(fs);
  const file = memoryFile(home);
  await io.makeDir(home);
  const body = text.endsWith("\n") ? text : text + "\n";
  await io.writeText(file, body);
  const info = await io.stat(file);
  return snapshotOf(file, body, info.mtimeMs);
}
