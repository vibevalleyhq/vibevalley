// Which language the words are said in. One owner, so one language a process: the server takes it from the settings, the
// page from the attribute the server writes on its <html> (apps/server src/http/page.ts).

export const LocaleValues = ["zh", "en"] as const;
export type Locale = (typeof LocaleValues)[number];

// In a page, the attribute is there before any module runs, so even words read while modules load are in the right one.
// The server and the shells have no document; a preload runs before the page has an <html> at all, and the DOM's type
// does not say documentElement can be null.
const root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement;
let current: Locale = root?.dataset.locale === "en" ? "en" : "zh";

export const currentLocale = (): Locale => current;

/** The server when the settings load or change. */
export function setLocale(locale: Locale) {
  current = locale;
}
