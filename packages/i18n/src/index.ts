import type { Messages } from "./catalogs";
import { format, type Params } from "./format";
import { currentLocale, type Locale } from "./locale";

export { currentLocale, setLocale, type Locale } from "./locale";
export { format, placeholders, type Params } from "./format";
export type { Messages } from "./catalogs";

export type MessageKey = keyof Messages;
/** A key's params: none for a message without placeholders, every one of them for a message with some. */
export type MessageArgs<K extends MessageKey> = Messages[K] extends Params ? [params: Messages[K]] : [];

export type Translator = (locale: Locale, key: string, params?: Params) => string;

let translator: Translator = (_locale, key, params) => (params ? format(key, params) : key);

export function setTranslator(fn: Translator): void {
  translator = fn;
}

/** The message for `key` in the language in use, its placeholders filled. */
export function t<K extends MessageKey>(key: K, ...args: MessageArgs<K>): string {
  return translator(currentLocale(), key, args[0]);
}

/** Items as the language lists them in a sentence. */
export const list = (items: readonly (string | number)[]): string => items.join(t("shared.join.separator"));
