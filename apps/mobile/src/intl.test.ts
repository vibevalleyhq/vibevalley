import { expect, test, vi } from "vite-plus/test";

test("regression: the shared formatter loads when Hermes has no plural rules", async () => {
  const saved = { PluralRules: Intl.PluralRules, Locale: Intl.Locale, getCanonicalLocales: Intl.getCanonicalLocales };
  try {
    for (const key of Object.keys(saved)) Object.defineProperty(Intl, key, { value: undefined, writable: true, configurable: true });
    vi.resetModules();
    await import("./intl");
    await import("@vibevalley/i18n");
    for (const type of ["cardinal", "ordinal"] as const) {
      const expected = new saved.PluralRules("en", { type });
      const actual = new Intl.PluralRules("en", { type });
      for (const value of [-1, 0, 1, 2, 3, 11, 12, 13, 21, 22, 23, 101, 1.0001, 1.0005]) expect(actual.select(value)).toBe(expected.select(value));
    }
  } finally {
    Object.assign(Intl, saved);
    vi.resetModules();
  }
});
