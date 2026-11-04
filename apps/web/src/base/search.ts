// A Chinese name is also found by its pinyin, whole or by initials or both (guanjia, gj, guanj → 管家; both readings
// of a character, cq and zq → 重庆). The dictionary is large, so it loads after the page opens; until it has, only the
// characters themselves match.
let spell: ((text: string, query: string) => boolean) | undefined;

/** Settles once pinyin matches too (tests wait on it). */
export const pinyinLoaded: Promise<void> = import("pinyin-pro").then(({ match }) => {
  spell = (text, query) => match(text, query, { continuous: true }) !== null;
});

const han = /\p{Script=Han}/u;
const letters = /^[a-z]+$/u;

/** The text holds the query, ignoring case, or spells it in pinyin; query is lower case. */
export function spelled(text: string, query: string): boolean {
  if (text.toLowerCase().includes(query)) return true;
  return spell !== undefined && letters.test(query) && han.test(text) && spell(text, query);
}

/** Every word of the query is somewhere in the texts (spelled), ignoring case; an empty query matches everything. */
export function matches(query: string, texts: readonly (string | undefined)[]) {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return true;
  const present = texts.filter((t): t is string => t !== undefined && t !== "");
  return words.every((w) => present.some((t) => spelled(t, w)));
}

export const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const or = (...c: number[]) => c.find((x) => x !== 0) ?? 0;
