// Fixture data for the stories and tests. The JSON files are written by
// `gen/` from the real Rust types (vibevalley_core, vibevalley_oar); times in them
// are relative to FIXTURE_NOW and are moved to the wall clock here.
import type { AgentEvent } from "../shapes";
import claude from "./events-claude.json";
import codex from "./events-codex.json";
import failed from "./events-error.json";
import long from "./events-long.json";

const FIXTURE_NOW = 1_794_499_600_000;

const TIME_KEYS = new Set([
  "at",
  "at_ms",
  "since",
  "created_at",
  "queued_at",
  "closed_at",
  "reviewed_at",
  "started_at",
  "ended_at",
  "hired_at",
  "assigned_at",
  "quiet_since",
]);

function shifted<T>(value: T, by: number): T {
  if (Array.isArray(value)) return value.map((v) => shifted(v, by)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = TIME_KEYS.has(k) && typeof v === "number" ? v + by : shifted(v, by);
    }
    return out as T;
  }
  return value;
}

export const events = {
  /** A Claude Code turn: reads, a failing test, an edit, a permission, a passing test. */
  claude: claude as unknown as AgentEvent[],
  /** The captured Codex trace: one command behind an approval. */
  codex: codex as unknown as AgentEvent[],
  /** The captured opencode trace: the provider's quota error. */
  error: failed as unknown as AgentEvent[],
  /** 200-character Chinese and English text, a 120-line output. */
  long: long as unknown as AgentEvent[],
};

/**
 * The first `n` events of a stream, moved so the last of them happened
 * `ago` ms before now: a run caught in the middle.
 */
export function cut(stream: AgentEvent[], n: number, ago = 1200, now = Date.now()): AgentEvent[] {
  const part = stream.slice(0, n);
  const last = part[part.length - 1]?.at_ms ?? FIXTURE_NOW;
  return shifted(part, now - ago - last);
}

/** A whole stream, ending `ago` ms before now. */
export function ended(stream: AgentEvent[], ago = 0, now = Date.now()): AgentEvent[] {
  return cut(stream, stream.length, ago, now);
}
