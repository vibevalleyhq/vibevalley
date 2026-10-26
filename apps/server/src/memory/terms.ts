// The words a memory and a turn are compared by: Chinese as gse cuts it, its search cut
// and its every-word cut together, so a phrase cut two ways (表名单数: 表/名单/数, 单数) is found either way, single
// characters left out; Latin words, numbers and code whole (a path or a version one word: db/migrations, v1.2.3). Stop
// words are left out: they match everything.

import stopwords from "./stopwords.json";
import { cutAll, cutSearch, goLower } from "./gse.ts";

/** Raised when the cut or the dictionary changes: every memory's terms are then cut again (recutTerms). */
export const termsVersion = 1;

/** Words too common to match on, in Chinese and in English (stopwords.json: data, not words to anyone). */
export const recallStop = new Set<string>(stopwords);

const codeWord = /[a-z0-9_][a-z0-9_.\-/]*[a-z0-9_]/g;
const han = /\p{Script=Han}/u;

/** Words in lower case, in the order they come, each once. */
export function termsList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (w: string) => {
    if (!seen.has(w) && !recallStop.has(w)) {
      seen.add(w);
      out.push(w);
    }
  };
  for (const cut of [cutSearch(text), cutAll(text)]) {
    for (const raw of cut) {
      const w = raw.trim();
      if (han.test(w) && [...w].length > 1) add(w);
    }
  }
  for (const w of goLower(text).match(codeWord) ?? []) add(w);
  return out;
}

export const termsOf = (text: string) => new Set(termsList(text));

/** What the terms column holds: the words, space-joined; the search vector is made of them. */
export const termsText = (text: string) => termsList(text).join(" ");

export function termsInCommon(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}
