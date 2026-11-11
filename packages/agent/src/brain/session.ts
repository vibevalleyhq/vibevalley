import { dirname } from "node:path";

import { Effect, type FileSystem, Schema } from "effect";

import { type BrainMessage, BrainMessageSchema, type CompactionSummaryMessage } from "../base/messages.ts";
import { type AgentFailed, agentFailed } from "../core/errors.ts";
import { agentFsOf } from "../infra/fs.ts";

export interface TranscriptStore {
  readonly readLines: Effect.Effect<BrainMessage[]>;
  readonly load: Effect.Effect<BrainMessage[]>;
  readonly append: (message: BrainMessage) => Effect.Effect<void, AgentFailed>;
  readonly clear: Effect.Effect<void, AgentFailed>;
}

export function applySummary(messages: readonly BrainMessage[], summary: CompactionSummaryMessage): BrainMessage[] {
  return [summary, ...(summary.kept > 0 ? messages.slice(Math.max(0, messages.length - summary.kept)) : [])];
}

export function replay(lines: readonly BrainMessage[]): BrainMessage[] {
  let out: BrainMessage[] = [];
  for (const m of lines) {
    if (m.role === "compactionSummary") out = applySummary(out, m);
    else out.push(m);
  }
  return out;
}

const BrainMessageJson = Schema.fromJsonString(BrainMessageSchema);
const decodeBrainMessage = Schema.decodeUnknownOption(BrainMessageJson);
const encodeBrainMessage = Schema.encodeEffect(BrainMessageJson);

function parseLines(text: string): BrainMessage[] {
  const out: BrainMessage[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    // A line cut off by a crash: the rest still reads.
    const decoded = decodeBrainMessage(line);
    if (decoded._tag === "Some") out.push(decoded.value);
  }
  return out;
}

/** Every line of a session file as written, the compactions among them and what they fold; empty when there is no file. */
export const readLines = (file: string, fs?: FileSystem.FileSystem): Effect.Effect<BrainMessage[]> =>
  agentFsOf(fs)
    .readTextIfExists(file)
    .pipe(
      Effect.map((text) => (text === undefined ? [] : parseLines(text))),
      Effect.tapError((e) => Effect.logWarning(`agent: cannot read session ${file}:`, e)),
      Effect.orElseSucceed((): BrainMessage[] => []),
    );

/** The conversation as it stands: the compactions applied. */
export const loadSession = (file: string, fs?: FileSystem.FileSystem): Effect.Effect<BrainMessage[]> => Effect.map(readLines(file, fs), replay);

/** A message added at the end; the caller waits for one before the next, so the lines keep their order. */
export const appendSession = (file: string, message: BrainMessage, fs?: FileSystem.FileSystem): Effect.Effect<void, AgentFailed> =>
  Effect.gen(function* () {
    const io = agentFsOf(fs);
    const line = yield* Effect.mapError(encodeBrainMessage(message), agentFailed);
    yield* io.makeDir(dirname(file));
    yield* io.appendText(file, line + "\n");
  });

export const clearSession = (file: string, fs?: FileSystem.FileSystem): Effect.Effect<void, AgentFailed> =>
  Effect.gen(function* () {
    const io = agentFsOf(fs);
    yield* io.makeDir(dirname(file));
    yield* io.writeText(file, "");
  });

export const fileTranscriptStore = (file: string, fs?: FileSystem.FileSystem): TranscriptStore => ({
  readLines: readLines(file, fs),
  load: loadSession(file, fs),
  append: (message) => appendSession(file, message, fs),
  clear: clearSession(file, fs),
});
