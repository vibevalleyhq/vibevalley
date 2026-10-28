// Which language the words are said in. One owner, so one language a process: the server takes it from the settings, the
// page from the attribute the server writes on its <html> (apps/server src/http/page.ts). Each word table (a words.ts,
// a words/ folder) is a Chinese table, its English twin typed by it, and an accessor that gives the one in use; what is
// said to models is not in them (prompts.ts).

import { currentLocale } from "@vibevalley/i18n";

export { currentLocale, setLocale } from "@vibevalley/i18n";

/** The accessor of a table: zh is the source, en has its shape (NoInfer: an entry missing or of the wrong kind is a
 * compile error in en, not a change to the shape). */
export function localized<T>(tables: { readonly zh: T; readonly en: NoInfer<T> }): () => T {
  return () => tables[currentLocale()];
}
