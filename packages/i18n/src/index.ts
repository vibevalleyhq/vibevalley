// The words said to the owner: catalogs per language and namespace (locales/<locale>/<namespace>.json), read by key.
// zh is the source; a message missing in another language falls back to it (scripts/i18n.ts check reports the gap).
// What is said to models is not here: it stays in each module's prompts.ts.

import { catalogs, type Messages } from "./catalogs";
import { format, type Params } from "./format";
import { currentLocale, type Locale } from "./locale";

export { currentLocale, LocaleValues, setLocale, type Locale } from "./locale";
export { format, placeholderKinds, placeholders, type Params, type Value } from "./format";
export type { Messages } from "./catalogs";

export type MessageKey = keyof Messages;
/** A key's params: none for a message without placeholders, every one of them for a message with some. */
export type MessageArgs<K extends MessageKey> = Messages[K] extends Params ? [params: Messages[K]] : [];

interface Nested {
  readonly [k: string]: string | Nested;
}

const tables = new Map<Locale, ReadonlyMap<string, string>>();

/** A language's messages by full key, flattened once. */
function table(locale: Locale): ReadonlyMap<string, string> {
  let flat = tables.get(locale);
  if (flat) return flat;
  const out = new Map<string, string>();
  const walk = (prefix: string, v: string | Nested) => {
    if (typeof v === "string") out.set(prefix, v);
    else for (const [k, x] of Object.entries(v)) walk(prefix + "." + k, x);
  };
  for (const [ns, v] of Object.entries(catalogs[locale])) walk(ns, v);
  flat = out;
  tables.set(locale, flat);
  return flat;
}

/** The message for `key` in the language in use, its placeholders filled. */
export function t<K extends MessageKey>(key: K, ...args: MessageArgs<K>): string {
  const text = table(currentLocale()).get(key) ?? table("zh").get(key) ?? key;
  return args[0] ? format(text, args[0]) : text;
}

/** The message for a key built from a value that may not name one (a mention, a failure's kind), or undefined. */
export function maybe(key: string): string | undefined {
  return table(currentLocale()).get(key) ?? table("zh").get(key);
}

/** Items as the language lists them in a sentence. */
export const list = (items: readonly (string | number)[]): string => items.join(t("shared.join.separator"));
