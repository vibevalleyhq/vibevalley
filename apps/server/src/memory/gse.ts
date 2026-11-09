// oxlint-disable-next-line vibevalley/sync-fs -- readNow, the fallback before loadSegmenter has read the data; once per process
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { Effect, FileSystem, Schema } from "effect";

import { serverFile } from "#/base/assets.ts";
import { jsonOf } from "#/base/json.ts";

const dataDir = serverFile("src/memory/data");

/** Go's strings.ToLower where it differs from JavaScript's: İ is a plain i (JavaScript adds a combining dot). */
export const goLower = (s: string) => s.replace(/İ/gu, "i").toLowerCase();

const isLetterOrNumber = /[\p{L}\p{N}]/u;
/** A letter keyOf might lower: below U+0800, from A up (digits and marks are kept as they are either way). */
const lowerable = /[A-Za-z\u00aa-\u07ff]/u;

/**
 * How gse keys a dictionary word: letters and digits of one or two UTF-8 bytes (Latin, Greek, Cyrillic…) lowered, the rest
 * as it is (SplitTextToWords, toLow).
 */
function keyOf(text: string): string {
  // Most words are all CJK, past U+0800: nothing in them is lowered.
  if (!lowerable.test(text)) return text;
  let out = "";
  for (const ch of text) out += (ch.codePointAt(0) ?? 0) < 0x800 && isLetterOrNumber.test(ch) ? goLower(ch) : ch;
  return out;
}

interface Dictionary {
  readonly freq: Map<string, number>;
  /** Every key, sorted: a prefix is known when the first key at or after it starts with it. */
  readonly sorted: readonly string[];
  readonly totalFreq: number;
}

let dictionary: Dictionary | undefined;

/** The segmenter's two files, gunzipped. */
const files = { dictionary: "zh_s.txt.gz", emit: "hmm_emit.json.gz" } as const;

/** Reads a file of the segmenter's at once: only when a cut comes before load has (a rule's test, a cut as the server
 * starts), and once. */
const readNow = (file: string) => gunzipSync(readFileSync(join(dataDir, file))).toString("utf8");

/** Reads the dictionary and the HMM's table on the file system, off the event loop. */
export const loadSegmenter = Effect.fn("Gse.loadSegmenter")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const read = (file: string) => Effect.map(fs.readFile(join(dataDir, file)), (bytes) => gunzipSync(bytes).toString("utf8"));
  if (dictionary === undefined) {
    const words = yield* read(files.dictionary);
    dictionary = dictionaryOf(words);
  }
  if (emitTable === undefined) {
    const emitJson = yield* read(files.emit);
    emitTable = yield* Schema.decodeEffect(Schema.fromJsonString(EmitTable))(emitJson);
  }
}, Effect.orDie);

const dict = (): Dictionary => (dictionary ??= dictionaryOf(readNow(files.dictionary)));

function dictionaryOf(text: string): Dictionary {
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
    // One character: one UTF-16 unit, or a surrogate pair.
    if (word.length < 2 || (word.length === 2 && word.charCodeAt(0) >= 0xd800 && word.charCodeAt(0) <= 0xdbff)) f = 2;
    const key = keyOf(word);
    // The first of two lines for one word stands.
    if (freq.has(key)) continue;
    freq.set(key, f);
    totalFreq += f;
  }
  return { freq, sorted: [...freq.keys()].toSorted(), totalFreq };
}

/** strconv.ParseFloat's: a number written whole, or nothing. */
function goParseFloat(text: string): number | undefined {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/u.test(text)) return undefined;
  return Number(text);
}

/** The word's frequency. 0 when it only begins a word. */
function find(word: string): number | undefined {
  const d = dict();
  const f = d.freq.get(word);
  if (f !== undefined) return f;
  const keys = d.sorted;
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((keys[mid] ?? "") < word) lo = mid + 1;
    else hi = mid;
  }
  return keys[lo]?.startsWith(word) === true ? 0 : undefined;
}

type Ends = readonly [number, ...number[]];

/** For each start, the ends of the dictionary words that start there; itself when none does. */
function dagOf(runes: readonly string[]): Ends[] {
  const n = runes.length;
  const dag: Ends[] = [];
  for (let k = 0; k < n; k++) {
    const ends: number[] = [];
    let i = k;
    let frag = runes[k] ?? "";
    for (;;) {
      const f = find(frag);
      if (f === undefined) break;
      if (f > 0) ends.push(i);
      i++;
      if (i >= n) break;
      frag += runes[i] ?? "";
    }
    const [first, ...rest] = ends;
    dag.push(first !== undefined ? [first, ...rest] : [k]);
  }
  return dag;
}

/** The most likely path through the DAG: each start's best end, from the back. */
function routesOf(runes: readonly string[]): { freq: number; index: number }[] {
  const dag = dagOf(runes);
  const n = runes.length;
  const routes: { freq: number; index: number }[] = Array.from({ length: n + 1 }, () => ({ freq: 0, index: 0 }));
  const logT = Math.log(dict().totalFreq);
  const score = (idx: number, end: number) => {
    const f = find(runes.slice(idx, end + 1).join(""));
    return { freq: (f === undefined ? 0 : Math.log(f)) - logT + (routes[end + 1]?.freq ?? 0), index: end };
  };
  for (let idx = n - 1; idx >= 0; idx--) {
    const [first, ...rest] = dag[idx] ?? [idx];
    let best = score(idx, first);
    for (const end of rest) {
      const r = score(idx, end);
      if (r.freq > best.freq || (r.freq === best.freq && r.index > best.index)) best = r;
    }
    routes[idx] = best;
  }
  return routes;
}

// As jieba's HMM: it cuts a run of single characters the dictionary does not know.
const HmmStateValues = ["B", "E", "M", "S"] as const;
type State = (typeof HmmStateValues)[number];

const EmitTable = Schema.Record(Schema.Literals(HmmStateValues), Schema.Record(Schema.String, Schema.Finite));
let emitTable: Record<State, Record<string, number>> | undefined;
const emitOf = jsonOf(EmitTable);
const emit = () => (emitTable ??= emitOf(readNow(files.emit)));

const minFloat = -3.14e100;
const prevStatus: Record<State, readonly [State, State]> = { B: ["E", "S"], M: ["M", "B"], S: ["S", "E"], E: ["B", "M"] };
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
  let vtb: Record<State, number> = { B: minFloat, M: minFloat, E: minFloat, S: minFloat };
  let path: Record<State, State[]> = { B: ["B"], M: ["M"], E: ["E"], S: ["S"] };
  const first = obs[0] ?? "";
  for (const y of states) {
    vtb[y] = (e[y][first] ?? minFloat) + probStart[y];
    path[y] = [y];
  }
  for (const ch of obs.slice(1)) {
    const next: Record<State, number> = { B: minFloat, M: minFloat, E: minFloat, S: minFloat };
    const newPath: Record<State, State[]> = { B: [], M: [], E: [], S: [] };
    for (const y of states) {
      const emP = e[y][ch] ?? minFloat;
      const stepFrom = (y0: State) => ({ prob: vtb[y0] + (probTrans[y0][y] ?? minFloat) + emP, state: y0 });
      const [s0, s1] = prevStatus[y];
      const best = better(stepFrom(s0), stepFrom(s1));
      next[y] = best.prob;
      newPath[y] = [...path[best.state], y];
    }
    vtb = next;
    path = newPath;
  }
  const last = better({ prob: vtb.E, state: "E" }, { prob: vtb.S, state: "S" });
  return path[last.state];
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
    const at = cut && nonCut ? Math.min(cut.index, nonCut.index) : (cut?.index ?? nonCut?.index);
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
    if (buf.length === 1 && buf[0] !== undefined) out.push(buf[0]);
    else if (buf.length > 1) out.push(...hmmRun(buf));
    buf = [];
  };
  for (let x = 0; x < runes.length;) {
    const y = (routes[x]?.index ?? x) + 1;
    if (y - x === 1) buf.push(runes[x] ?? "");
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
  dag.forEach(([first, ...rest], k) => {
    if (rest.length === 0 && k > start) {
      out.push(runes.slice(k, first + 1).join(""));
      start = first;
      return;
    }
    for (const j of [first, ...rest]) {
      if (j > k) {
        out.push(runes.slice(k, j + 1).join(""));
        start = j;
      }
    }
  });
  return out;
}
