import { dirname } from "node:path";

import { type BrainMessage, BrainMessageSchema, type CompactionSummaryMessage } from "../base/messages.ts";
import { agentFailed } from "../core/errors.ts";
import { type AgentFs, agentFsOf } from "../infra/fs.ts";
import { type AgentLog, consoleLog } from "../infra/log.ts";

/** readLines and load never fail: a transcript that cannot be read is empty (and logged). append and clear throw an
 * AgentFailed. */
export interface TranscriptStore {
  readonly readLines: () => Promise<BrainMessage[]>;
  readonly load: () => Promise<BrainMessage[]>;
  readonly append: (message: BrainMessage) => Promise<void>;
  readonly clear: () => Promise<void>;
}
export function applySummary(messages: readonly BrainMessage[], summary: CompactionSummaryMessage): BrainMessage[] {
  return [summary, ...(summary.kept > 0 ? messages.slice(Math.max(0, messages.length - summary.kept)) : [])];
}

function replay(lines: readonly BrainMessage[]): BrainMessage[] {
  let out: BrainMessage[] = [];
  for (const m of lines) {
    if (m.role === "compactionSummary") out = applySummary(out, m);
    else out.push(m);
  }
  return out;
}

function parseLines(text: string): BrainMessage[] {
  const out: BrainMessage[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    // A line cut off by a crash: the rest still reads.
    const decoded = BrainMessageSchema.safeParse(jsonOrUndefined(line));
    if (decoded.success) out.push(decoded.data);
  }
  return out;
}

function jsonOrUndefined(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    // Not JSON (a line cut off): the Schema refuses it like any other wrong line.
    return undefined;
  }
}

/** Every line of a session file as written, the compactions among them and what they fold; empty when there is no file. */
async function readLines(file: string, fs?: AgentFs, log: AgentLog = consoleLog): Promise<BrainMessage[]> {
  try {
    const text = await agentFsOf(fs).readTextIfExists(file);
    return text === undefined ? [] : parseLines(text);
  } catch (e) {
    log.warn(`agent: cannot read session ${file}:`, e);
    return [];
  }
}

/** The conversation as it stands: the compactions applied. */
export const loadSession = async (file: string, fs?: AgentFs, log?: AgentLog): Promise<BrainMessage[]> => replay(await readLines(file, fs, log));

/** A message added at the end; the caller waits for one before the next, so the lines keep their order. */
export async function appendSession(file: string, message: BrainMessage, fs?: AgentFs): Promise<void> {
  const io = agentFsOf(fs);
  // Written as the Schema reads it: its fields in its order, nothing else.
  const encoded = BrainMessageSchema.safeParse(message);
  if (!encoded.success) throw agentFailed(encoded.error);
  const line = JSON.stringify(encoded.data);
  await io.makeDir(dirname(file));
  await io.appendText(file, line + "\n");
}

async function clearSession(file: string, fs?: AgentFs): Promise<void> {
  const io = agentFsOf(fs);
  await io.makeDir(dirname(file));
  await io.writeText(file, "");
}

export const fileTranscriptStore = (file: string, fs?: AgentFs, log?: AgentLog): TranscriptStore => ({
  readLines: () => readLines(file, fs, log),
  load: () => loadSession(file, fs, log),
  append: (message) => appendSession(file, message, fs),
  clear: () => clearSession(file, fs),
});
