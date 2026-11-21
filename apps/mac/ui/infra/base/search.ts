import { richNative } from "../../design/rich/native";

const han = /\p{Script=Han}/u;

/** The text holds the query, ignoring case, or spells it in pinyin; query is lower case. */
export function spelled(text: string, query: string): boolean {
  const q = query.toLowerCase();
  if (text.toLowerCase().includes(q)) return true;
  if (q === "" || !han.test(text)) return false;
  return richNative()?.matchPinyin(text, q) ?? false;
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
