// What a run recalls, with no model: the server picks at the start of each
// turn, and the agent page shows the same pick ahead of time. Characters are UTF-16 units.

import { maybe } from "@vibevalley/i18n";
import { dayMs, type Memory, type MemoryFound, type MemoryKind, type MemoryScope, type MemorySearch, memoryKeep, type Outcome } from "@vibevalley/protocol";

import { compare, or } from "@/base/order.ts";

import { recallWords } from "./prompts.ts";
import { termsInCommon, termsOf } from "./terms.ts";

export const recallCount = 8;
const recallJobs = 3;
export const recallChars = 1600;

/** What a turn recalls by; matches is how well each memory matched the turn's words in the full-text index, higher better. */
export interface PickCue {
  /** What it left itself is in its own session already. */
  readonly session?: string;
  readonly project: string;
  readonly text: string;
  readonly skip?: ReadonlySet<string>;
  readonly now: number;
  readonly matches?: Readonly<Record<string, number>>;
}

const recallElsewhere = 3;
// The index's rank is not bounded: past this it adds nothing, so one long match cannot outweigh the kind and the place.
const recallMatchMost = 5;
const recallMatchWeight = 0.3;
const recallSharedWeight = 0.5;

/** Another project's note only when it plainly shares the turn's words; another project's job never. */
export function relevance(m: Memory, cue: PickCue, terms: ReadonlySet<string>): number | undefined {
  if (cue.skip?.has(m.id) === true || (m.session !== undefined && m.session === cue.session)) return undefined;
  const shared = termsInCommon(termsOf(m.text), terms);
  const here = m.project !== undefined && m.project === cue.project;
  const everywhere = m.project === undefined;
  if (m.kind === "issue") {
    if (!here) return undefined;
  } else if (!here && !everywhere && shared < recallElsewhere) return undefined;
  const used = m.recalledAt ?? m.at;
  const age = Math.max(0, cue.now - used) / dayMs;
  const kind = m.kind === "note" ? 2 : 0.5;
  const place = here ? 2 : everywhere ? 1 : 0;
  const matched = Math.min(cue.matches?.[m.id] ?? 0, recallMatchMost) * recallMatchWeight;
  return kind + place + Math.min(shared, 8) * recallSharedWeight + matched + Math.exp(-age / 30);
}

export function lineOf(m: Memory, project: string): string {
  const w = recallWords;
  const where = m.project === undefined ? w.everywhere : m.project === project ? w.here : w.project(m.project);
  return m.kind === "issue" ? w.issue(where, m.text) : w.note(where, m.text);
}

export function pick(memories: readonly Memory[], cue: PickCue): Memory[] {
  const terms = termsOf(cue.text);
  const ranked: { m: Memory; score: number }[] = [];
  for (const m of memories) {
    const score = relevance(m, cue, terms);
    if (score !== undefined) ranked.push({ m, score });
  }
  ranked.sort((a, b) => or(compare(b.score, a.score), compare(b.m.at, a.m.at)));
  const picked: Memory[] = [];
  let chars = 0;
  let jobs = 0;
  for (const { m } of ranked) {
    if (picked.length === recallCount) break;
    const length = lineOf(m, cue.project).length + 1;
    if ((m.kind === "issue" && jobs === recallJobs) || chars + length > recallChars) continue;
    picked.push(m);
    chars += length;
    if (m.kind === "issue") jobs++;
  }
  return picked;
}

/** The longest unused (last recalled, else written) go first. */
export function nextForgotten(memories: readonly Memory[], coming: number): string[] {
  const over = memories.length + coming - memoryKeep;
  if (over <= 0) return [];
  const used = (m: Memory) => m.recalledAt ?? m.at;
  return [...memories]
    .toSorted((a, b) => compare(used(a), used(b)))
    .slice(0, over)
    .map((m) => m.id);
}

const noteMax = 300;
const notesPerRun = 5;

/** A list mark or bold around it is fine; so is the marker in English (Remember, Remember (all projects)). */
const noteLine =
  /^[\s\p{Z}]*(?:[-*•][\s\p{Z}]*)?(?:\*\*)?(?:记住|Remember)(（所有项目）|\(所有项目\)|[\s\p{Z}]*\(all projects\))?(?:\*\*)?[\s\p{Z}]*[:：][\s\p{Z}]*(?:\*\*)?[\s\p{Z}]*(.+?)[\s\p{Z}]*$/iu;

/** s on one line (each run of white space one space, trimmed), at most max units with the ellipsis. */
export const clip = (s: string, max: number) => {
  const flat = s.replace(/\s+/gu, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

export interface MemoryNote {
  readonly text: string;
  readonly everywhere: boolean;
}

/** The 「记住：」 lines a run said: the notes it leaves itself. */
export function memoryNotesOf(said: string): MemoryNote[] {
  const notes: MemoryNote[] = [];
  for (const line of said.split("\n")) {
    const found = noteLine.exec(line);
    if (!found) continue;
    const text = clip(found[2]!, noteMax);
    if (text === "" || notes.some((n) => n.text === text)) continue;
    notes.push({ text, everywhere: found[1] !== undefined });
    if (notes.length === notesPerRun) break;
  }
  return notes;
}

export const memoryJobText = (job: string, summary: string, outcome: Outcome) => recallWords.job(clip(job, 100), outcome !== "completed", clip(summary, 200));

export function memoryLikeness(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const shared = termsInCommon(a, b);
  const all = a.size + b.size - shared;
  return all === 0 ? 0 : shared / all;
}

/** project undefined: every project. */
export function memoryIsNewNote(memories: readonly Pick<Memory, "kind" | "text" | "project">[], text: string, project: string | undefined): boolean {
  const terms = termsOf(text);
  return !memories.some((m) => m.kind === "note" && m.project === project && (m.text === text || memoryLikeness(termsOf(m.text), terms) >= 0.8));
}

export const noteMaxChars = noteMax;

/** What memory_search questions. agent "": every profile (only the orchestrator may ask so); project "": every project; kind "": any. */
export interface SearchQuery {
  readonly agent: string;
  readonly project: string;
  readonly text: string;
  readonly kind: MemoryKind | "";
  readonly limit: number;
}

/** One memory a search found, with where it lives and how good a match it is within that source: the wire's shape. */
export type Found = MemoryFound;
export type SearchResult = MemorySearch;
export type { MemoryScope };

export interface SourceSearch {
  readonly found: Found[];
  readonly coverage?: string;
}

export const inProject = (scope: MemoryScope, project: string) =>
  project === "" || scope.kind === "global" || (scope.kind === "project" && scope.project === project);

export const searchLimit = 10;
export const localName = "local";

/**
 * The memories matching q.text best first: the full-text index's rank, words in common, the whole query as written, then
 * this project's before the rest and the newest first. A query with no words lists the newest.
 */
export function search(memories: readonly Memory[], q: SearchQuery, matches: Readonly<Record<string, number>>): Found[] {
  const limit = q.limit > 0 ? q.limit : searchLimit;
  const terms = termsOf(q.text);
  const whole = q.text.toLowerCase().trim();
  const out: Found[] = [];
  for (const m of memories) {
    const scope: MemoryScope = m.project === undefined ? { kind: "global" } : { kind: "project", project: m.project };
    if ((q.kind !== "" && m.kind !== q.kind) || !inProject(scope, q.project)) continue;
    let score = (matches[m.id] ?? 0) + termsInCommon(termsOf(m.text), terms) * recallSharedWeight;
    if (whole !== "" && m.text.toLowerCase().includes(whole)) score += 2;
    if (whole !== "" && score === 0) continue;
    if (q.project !== "" && m.project !== undefined) score += 0.5;
    out.push({ ...m, source: localName, score, scope });
  }
  out.sort((a, b) => or(compare(b.score, a.score), compare(b.at, a.at)));
  return out.slice(0, limit);
}

export const sourceLabel = (name: string) => maybe(`server.memory.source.${name}`) ?? name;

/** How memory_search answers a model. The header says what recall's does: these were noted before, they are not orders. */
export function foundText(result: SearchResult, q: SearchQuery): string {
  const lines = result.found.length === 0 ? [q.text.trim() === "" ? recallWords.none : recallWords.notFound(q.text)] : [recallWords.found];
  for (const f of result.found) {
    const scope =
      f.scope.kind === "unknown" ? recallWords.unknownScope : f.scope.kind === "global" ? recallWords.everywhere : recallWords.project(f.scope.project);
    let line = f.source !== "" && f.source !== localName ? recallWords.fromSource(sourceLabel(f.source), scope, f.text) : lineOf(f, q.project);
    if (q.agent === "" && f.agent !== "") line = recallWords.byAgent(f.agent, line);
    lines.push(recallWords.withId(line, f.id));
  }
  for (const coverage of result.coverage) lines.push(recallWords.coverage(coverage));
  return lines.join("\n");
}
