// Chinese word segmentation as gse v1.1.0 cuts it (github.com/go-ego/gse, Apache-2.0): the same
// dictionary (data/zh_s.txt.gz, gse's simplified Chinese s_1.txt) and jieba's HMM for runs the dictionary does not know
// (data/hmm_emit.json.gz, from gse's hmm/prob_emit.go). Only the cuts the memory search uses are here: the search cut with
// the HMM (CutSearch(text, true)) and the cut into every dictionary word (CutAll). The recorded cases
// (terms.test.ts) hold the two to the same words.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const dataDir = join(import.meta.dirname, "data");

/** Go's strings.ToLower where it differs from JavaScript's: İ is a plain i (JavaScript adds a combining dot). */
export const goLower = (s: string) => s.replace(/İ/gu, "i").toLowerCase();

const isLetterOrNumber = /[\p{L}\p{N}]/u;

/**
 * How gse keys a dictionary word: letters and digits of one or two UTF-8 bytes (Latin, Greek, Cyrillic…) lowered, the rest
 * as it is (SplitTextToWords, toLow).
 */
function keyOf(text: string): string {
  let out = "";
  for (const ch of text) out += ch.codePointAt(0)! < 0x800 && isLetterOrNumber.test(ch) ? goLower(ch) : ch;
  return out;
}

interface Dictionary {
  readonly freq: Map<string, number>;
  /** Every key, sorted: a prefix is known when the first key at or after it starts with it. */
  readonly sorted: readonly string[];
  readonly totalFreq: number;
}

let dictionary: Dictionary | undefined;

function dict(): Dictionary {
  if (dictionary) return dictionary;
  const text = gunzipSync(readFileSync(join(dataDir, "zh_s.txt.gz"))).toString("utf8");
  const freq = new Map<string, number>();
  let totalFreq = 0;
  for (const line of text.split("\n")) {
    // A line is "word freq pos", split on single spaces; one without a frequency is left out, as one below 2.
    const first = line.indexOf(" ");
    if (first < 0) continue;
    const word = line.slice(0, first).trim();
    const rest = line.slice(first + 1);
    const second = rest.indexOf(" ");
    const freqText = (second < 0 ? rest : rest.slice(0, second)).trim();
    let f = goParseFloat(freqText);
    if (f === undefined || f < 2) continue;
    if ([...word].length < 2) f = 2;
    const key = keyOf(word);
    // The first of two lines for one word stands.
    if (freq.has(key)) continue;
    freq.set(key, f);
    totalFreq += f;
  }
  dictionary = { freq, sorted: [...freq.keys()].toSorted(), totalFreq };
  return dictionary;
}

/** strconv.ParseFloat's: a number written whole, or nothing. */
function goParseFloat(text: string): number | undefined {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/u.test(text)) return undefined;
  return Number(text);
}

/** The word's frequency; 0 when it only begins a word; undefined when nothing begins with it (gse's Find). */
function find(word: string): number | undefined {
  const d = dict();
  const f = d.freq.get(word);
  if (f !== undefined) return f;
  const keys = d.sorted;
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]! < word) lo = mid + 1;
    else hi = mid;
  }
  return lo < keys.length && keys[lo]!.startsWith(word) ? 0 : undefined;
}

/** For each start, the ends of the dictionary words that start there; itself when none does. */
function dagOf(runes: readonly string[]): number[][] {
  const n = runes.length;
  const dag: number[][] = [];
  for (let k = 0; k < n; k++) {
    const ends: number[] = [];
    let i = k;
    let frag = runes[k]!;
    for (;;) {
      const f = find(frag);
      if (f === undefined) break;
      if (f > 0) ends.push(i);
      i++;
      if (i >= n) break;
      frag += runes[i]!;
    }
    dag.push(ends.length > 0 ? ends : [k]);
  }
  return dag;
}

/** The most likely path through the DAG: each start's best end, from the back. */
function routesOf(runes: readonly string[]): { freq: number; index: number }[] {
  const dag = dagOf(runes);
  const n = runes.length;
  const routes: { freq: number; index: number }[] = [];
  routes[n] = { freq: 0, index: 0 };
  const logT = Math.log(dict().totalFreq);
  for (let idx = n - 1; idx >= 0; idx--) {
    let best: { freq: number; index: number } | undefined;
    for (const i of dag[idx]!) {
      const f = find(runes.slice(idx, i + 1).join(""));
      const r = { freq: (f === undefined ? Math.log(1) : Math.log(f)) - logT + routes[i + 1]!.freq, index: i };
      if (!best || best.freq < r.freq || (best.freq === r.freq && best.index < r.index)) best = r;
    }
    routes[idx] = best!;
  }
  return routes;
}

// As jieba's HMM: it cuts a run of single characters the dictionary does not know.
type State = "B" | "E" | "M" | "S";

let emitTable: Record<State, Record<string, number>> | undefined;
const emit = () =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the segmenter's table, shipped with the package
  (emitTable ??= JSON.parse(gunzipSync(readFileSync(join(dataDir, "hmm_emit.json.gz"))).toString("utf8")) as Record<State, Record<string, number>>);

const minFloat = -3.14e100;
const prevStatus: Record<State, readonly State[]> = { B: ["E", "S"], M: ["M", "B"], S: ["S", "E"], E: ["B", "M"] };
const probStart: Record<State, number> = { B: -0.26268660809250016, E: -3.14e100, M: -3.14e100, S: -1.4652633398537678 };
const probTrans: Record<State, Partial<Record<State, number>>> = {
  B: { E: -0.51082562376599, M: -0.916290731874155 },
  E: { B: -0.5897149736854513, S: -0.8085250474669937 },
  M: { E: -0.33344856811948514, M: -1.2603623820268226 },
  S: { B: -0.7211965654669841, S: -0.6658631448798212 },
};
const states: readonly State[] = ["B", "M", "E", "S"];

/** The better of two: the likelier, and on a tie the later state letter (Go sorts them in reverse). */
const better = (a: { prob: number; state: State }, b: { prob: number; state: State }) => (b.prob > a.prob || (b.prob === a.prob && b.state > a.state) ? b : a);

function viterbi(obs: readonly string[]): State[] {
  const e = emit();
  let vtb: Record<string, number> = {};
  let path: Record<string, State[]> = {};
  for (const y of states) {
    vtb[y] = (e[y][obs[0]!] ?? minFloat) + probStart[y];
    path[y] = [y];
  }
  for (let t = 1; t < obs.length; t++) {
    const next: Record<string, number> = {};
    const newPath: Record<string, State[]> = {};
    for (const y of states) {
      const emP = e[y][obs[t]!] ?? minFloat;
      let best: { prob: number; state: State } | undefined;
      for (const y0 of prevStatus[y]) {
        const p = { prob: vtb[y0]! + (probTrans[y0][y] ?? minFloat) + emP, state: y0 };
        best = best ? better(best, p) : p;
      }
      next[y] = best!.prob;
      newPath[y] = [...path[best!.state]!, y];
    }
    vtb = next;
    path = newPath;
  }
  const last = better({ prob: vtb.E!, state: "E" }, { prob: vtb.S!, state: "S" });
  return path[last.state]!;
}

function hmmInternal(text: string): string[] {
  const runes = [...text];
  const pos = viterbi(runes);
  const out: string[] = [];
  let begin = 0;
  let next = 0;
  runes.forEach((ch, i) => {
    switch (pos[i]) {
      case "B":
        begin = i;
        break;
      case "E":
        out.push(runes.slice(begin, i + 1).join(""));
        next = i + 1;
        break;
      case "S":
        out.push(ch);
        next = i + 1;
        break;
      case undefined:
      case "M":
        break;
    }
  });
  if (next < runes.length) out.push(runes.slice(next).join(""));
  return out;
}

const han = /\p{Script=Han}+/u;
const skip = /(\d+\.\d+|[a-zA-Z0-9]+)/u;

/** gse's hmm.Cut with its own patterns: runs of Han by the model, numbers and Latin words whole, the rest as it comes. */
function hmmCut(input: string): string[] {
  const out: string[] = [];
  let text = input;
  for (;;) {
    const cut = han.exec(text);
    if (!cut) {
      if (text.length === 0) break;
    } else if (cut.index === 0) {
      out.push(...hmmInternal(cut[0]));
      text = text.slice(cut[0].length);
      continue;
    }
    const nonCut = skip.exec(text);
    if (!nonCut) {
      if (text.length === 0) break;
    } else if (nonCut.index === 0) {
      text = text.slice(nonCut[0].length);
      if (nonCut[0] !== "") {
        out.push(nonCut[0]);
        continue;
      }
    }
    const at = !cut && !nonCut ? undefined : !cut ? nonCut!.index : !nonCut || cut.index < nonCut.index ? cut.index : nonCut.index;
    if (at === undefined) {
      out.push(text);
      break;
    }
    out.push(text.slice(0, at));
    text = text.slice(at);
  }
  return out;
}

function hmmRun(buf: string[]): string[] {
  const text = buf.join("");
  const f = find(text);
  return f === undefined || f === 0 ? hmmCut(text) : [...buf];
}

/** gse's cutDAG: the dictionary's best path, runs of single characters by the HMM. */
function cutDAG(input: string): string[] {
  const runes = [...goLower(input)];
  const routes = routesOf(runes);
  const out: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length === 1) out.push(buf[0]!);
    else if (buf.length > 1) out.push(...hmmRun(buf));
    buf = [];
  };
  for (let x = 0; x < runes.length;) {
    const y = routes[x]!.index + 1;
    if (y - x === 1) buf.push(runes[x]!);
    else {
      flush();
      out.push(runes.slice(x, y).join(""));
    }
    x = y;
  }
  flush();
  return out;
}

/** gse's CutSearch(text, true): the cut, each word preceded by the two- and three-character dictionary words inside it. */
export function cutSearch(text: string): string[] {
  const out: string[] = [];
  for (const word of cutDAG(text)) {
    const runes = [...word];
    for (const incr of [2, 3]) {
      if (runes.length <= incr) continue;
      for (let i = 0; i < runes.length - incr + 1; i++) {
        const gram = runes.slice(i, i + incr).join("");
        if ((find(gram) ?? 0) > 0) out.push(gram);
      }
    }
    out.push(word);
  }
  return out;
}

/** gse's CutAll: every dictionary word in the text. */
export function cutAll(text: string): string[] {
  const runes = [...goLower(text)];
  const dag = dagOf(runes);
  const out: string[] = [];
  let start = -1;
  for (let k = 0; k < dag.length; k++) {
    const ends = dag[k]!;
    if (ends.length === 1 && k > start) {
      out.push(runes.slice(k, ends[0]! + 1).join(""));
      start = ends[0]!;
      continue;
    }
    for (const j of ends) {
      if (j > k) {
        out.push(runes.slice(k, j + 1).join(""));
        start = j;
      }
    }
  }
  return out;
}
