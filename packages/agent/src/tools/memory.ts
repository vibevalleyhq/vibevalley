import { createHash } from "node:crypto";
import { basename, join } from "node:path";

import { DateTime, Effect, type FileSystem } from "effect";

import { memory as memoryWords } from "../base/prompts.ts";
import { type AgentFailed } from "../core/errors.ts";
import { agentFsOf } from "../infra/fs.ts";

/** Cut from the top when the prompt carries it: the newest notes matter most. */
const memoryPromptChars = 8_000;

/** The standalone agent's file adapter; hosted agents can inject another MemoryPort. */
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

export interface MemoryPort {
  readonly read: () => Effect.Effect<{ readonly prompt: string; readonly lines: readonly string[] }>;
  readonly remember: (note: string) => Effect.Effect<void, AgentFailed>;
  readonly rewrite: (content: string) => Effect.Effect<number, AgentFailed>;
}

export const fileMemory = (home: string, now: () => number, fs?: FileSystem.FileSystem): MemoryPort => ({
  read: () =>
    Effect.gen(function* () {
      const [snap, lines] = yield* Effect.all([readMemory(home, fs), memoryFileLines(home, fs)], { concurrency: 2 });
      return { prompt: snap.prompt, lines };
    }).pipe(
      Effect.tapError((e) => Effect.logWarning(`agent: cannot read memory in ${home}:`, e)),
      Effect.orElseSucceed((): { readonly prompt: string; readonly lines: readonly string[] } => ({ prompt: "", lines: [] })),
    ),
  remember: (note) => Effect.asVoid(remember(home, note, now(), fs)),
  rewrite: (content) => Effect.map(rewriteMemory(home, content, fs), (s) => s.lineCount),
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

export const readMemory = (home: string, fs?: FileSystem.FileSystem): Effect.Effect<MemorySnapshot, AgentFailed> =>
  Effect.gen(function* () {
    const io = agentFsOf(fs);
    const file = memoryFile(home);
    const text = yield* io.readTextIfExists(file);
    if (text === undefined) return snapshotOf(file, "", 0);
    const info = yield* io.stat(file);
    return snapshotOf(file, text, info.mtimeMs);
  });

/** MEMORY.md's lines as the model is told them: neither blank nor headings, without their bullet. */
const memoryFileLines = (home: string, fs?: FileSystem.FileSystem): Effect.Effect<string[], AgentFailed> =>
  Effect.map(agentFsOf(fs).readTextIfExists(memoryFile(home)), (raw) =>
    (raw ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((t) => t !== "" && !t.startsWith("#"))
      .map((t) => t.replace(bulletHead, "")),
  );

export const forgetLine = (home: string, id: string, fs?: FileSystem.FileSystem): Effect.Effect<void, AgentFailed> =>
  Effect.gen(function* () {
    const io = agentFsOf(fs);
    const file = memoryFile(home);
    const text = yield* io.readTextIfExists(file);
    if (text === undefined) return;
    const lines = text.split("\n");
    const i = lines.findIndex((l) => l.trim() !== "" && lineID(l) === id);
    if (i >= 0) yield* io.writeText(file, [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n"));
  });

/** YYYY-MM-DD where this machine is. */
const localDate = (now: number) => DateTime.formatIsoDate(DateTime.makeZonedUnsafe(now, { timeZone: DateTime.zoneMakeLocal() }));

/** now: epoch milliseconds. */
export const remember = (home: string, note: string, now: number, fs?: FileSystem.FileSystem): Effect.Effect<MemoryLine, AgentFailed> =>
  Effect.gen(function* () {
    const io = agentFsOf(fs);
    yield* io.makeDir(home);
    const date = localDate(now);
    const cleaned = note.replace(/\s*\n\s*/gu, " ").trim();
    const line = `- ${date} ${cleaned}`;
    yield* io.appendText(memoryFile(home), line + "\n");
    return { id: lineID(line), date, text: cleaned };
  });

const rewriteMemory = (home: string, text: string, fs?: FileSystem.FileSystem): Effect.Effect<MemorySnapshot, AgentFailed> =>
  Effect.gen(function* () {
    const io = agentFsOf(fs);
    const file = memoryFile(home);
    yield* io.makeDir(home);
    const body = text.endsWith("\n") ? text : text + "\n";
    yield* io.writeText(file, body);
    const info = yield* io.stat(file);
    return snapshotOf(file, body, info.mtimeMs);
  });

const archiveDir = (home: string) => join(home, "archive");

/** The UTC ISO time with its colons and dot made dashes. */
const isoStamp = (now: number) => DateTime.formatIso(DateTime.makeUnsafe(now)).replace(/[:.]/gu, "-");

/** now: epoch milliseconds. */
export const archive = (home: string, session: string, text: string, now: number, fs?: FileSystem.FileSystem): Effect.Effect<string, AgentFailed> =>
  Effect.gen(function* () {
    const io = agentFsOf(fs);
    yield* io.makeDir(archiveDir(home));
    const path = join(archiveDir(home), `${session}-${isoStamp(now)}.md`);
    yield* io.writeText(path, text);
    return path;
  });

const archiveNames = (io: ReturnType<typeof agentFsOf>, home: string): Effect.Effect<string[]> =>
  io.readDir(archiveDir(home)).pipe(
    Effect.map((names) => names.filter((n) => n.endsWith(".md"))),
    Effect.catchTag("AgentFailed", () => Effect.succeed<string[]>([])),
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

export const archiveFiles = (home: string, fs?: FileSystem.FileSystem): Effect.Effect<ArchiveFile[], AgentFailed> =>
  Effect.gen(function* () {
    const io = agentFsOf(fs);
    const names = yield* archiveNames(io, home);
    const files = yield* Effect.forEach(
      names,
      (name) =>
        Effect.gen(function* () {
          const path = join(archiveDir(home), name);
          const [info, text] = yield* Effect.all([io.stat(path), io.readText(path)], { concurrency: 2 });
          return { name, at: Math.trunc(info.mtimeMs), chars: text.length };
        }),
      { concurrency: 16 },
    );
    return files.toSorted((a, b) => b.at - a.at);
  });

/** A name with a path in it is none. */
export const readArchive = (home: string, name: string, fs?: FileSystem.FileSystem): Effect.Effect<string | undefined, AgentFailed> =>
  name !== basename(name) || !name.endsWith(".md") ? Effect.undefined : agentFsOf(fs).readTextIfExists(join(archiveDir(home), name));

/** Any case; 20 hits when limit is 0. */
export const searchArchive = (home: string, query: string, limit = 0, fs?: FileSystem.FileSystem): Effect.Effect<ArchiveHit[], AgentFailed> =>
  Effect.gen(function* () {
    const io = agentFsOf(fs);
    const most = limit > 0 ? limit : 20;
    const q = query.trim().toLowerCase();
    const hits: ArchiveHit[] = [];
    if (q === "") return hits;
    const names = yield* archiveNames(io, home);
    for (const file of names.toSorted().toReversed()) {
      const content = yield* io.readText(join(archiveDir(home), file));
      const lines = content.split("\n");
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
  });
