export const LocaleValues = ["zh", "en"] as const;
export type Locale = (typeof LocaleValues)[number];

// In a page, the attribute is there before any module runs, so even words read while modules load are in the right one.
const root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement;
let current: Locale = root?.dataset.locale === "en" ? "en" : "zh";

export const currentLocale = (): Locale => current;

/** The server when the settings load or change. */
export function setLocale(locale: Locale) {
  current = locale;
}
