import { colorScheme } from "nsh";

// What nsh 0.5.0's JS engine lacks and the reused VibeValley code calls.
// Import it first in every entry that loads VibeValley modules.
// The engine has Intl.NumberFormat and Intl.DateTimeFormat only.

type PluralType = "cardinal" | "ordinal";

/** English plural rules (CLDR), the only ones VibeValley's i18n asks for (`new Intl.PluralRules("en")`). */
class PluralRules {
  readonly #type: PluralType;
  constructor(_locale?: string, options?: { type?: PluralType }) {
    this.#type = options?.type ?? "cardinal";
  }
  select(n: number): string {
    if (this.#type === "cardinal") return n === 1 ? "one" : "other";
    const ten = n % 10;
    const hundred = n % 100;
    if (ten === 1 && hundred !== 11) return "one";
    if (ten === 2 && hundred !== 12) return "two";
    if (ten === 3 && hundred !== 13) return "few";
    return "other";
  }
}

const intl = (globalThis as { Intl?: Record<string, unknown> }).Intl;
if (intl && !intl.PluralRules) intl.PluralRules = PluralRules;

// The engine's DateTimeFormat speaks English whatever the locale: Chinese
// dates are written here (年 月 日, 周五, 24-hour time); others go through.
const Native = intl?.DateTimeFormat as typeof Intl.DateTimeFormat | undefined;
if (intl && Native && /^[A-Za-z]/u.test(new Native("zh", { weekday: "short" }).format(0))) {
  const English = Native;
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const two = (n: number) => String(n).padStart(2, "0");
  class ChineseDates {
    readonly #o: Intl.DateTimeFormatOptions;
    readonly #native: Intl.DateTimeFormat;
    constructor(locale?: string | string[], options: Intl.DateTimeFormatOptions = {}) {
      this.#native = new English(locale, options);
      const first = Array.isArray(locale) ? locale[0] : locale;
      this.#o = first?.toLowerCase().startsWith("zh") === true ? options : {};
      this.zh = first?.toLowerCase().startsWith("zh") === true;
    }
    readonly zh: boolean;
    format(at?: number | Date): string {
      if (!this.zh) return this.#native.format(at);
      const d = new Date(at ?? Date.now());
      const o = this.#o;
      const none = !o.year && !o.month && !o.day && !o.weekday && !o.hour && !o.minute && !o.dateStyle && !o.timeStyle;
      const date = none || o.dateStyle !== undefined ? { year: "numeric", month: "numeric", day: "numeric" } : o;
      let out = "";
      if (date.year) out += `${d.getFullYear()}年`;
      if (date.month) out += date.month === "2-digit" ? `${two(d.getMonth() + 1)}月` : `${d.getMonth() + 1}月`;
      if (date.day) out += date.day === "2-digit" ? `${two(d.getDate())}日` : `${d.getDate()}日`;
      if (o.weekday)
        out +=
          (out ? " " : "") +
          (o.weekday === "narrow" ? weekdays[d.getDay()] : o.weekday === "long" ? `星期${weekdays[d.getDay()]}` : `周${weekdays[d.getDay()]}`);
      if (o.hour || o.minute || o.timeStyle) out += (out ? " " : "") + `${two(d.getHours())}:${two(d.getMinutes())}`;
      return out;
    }
    formatToParts(at?: number | Date) {
      return this.zh ? [{ type: "literal", value: this.format(at) }] : this.#native.formatToParts(at);
    }
    resolvedOptions() {
      return this.#native.resolvedOptions();
    }
  }
  intl.DateTimeFormat = ChineseDates;
}

const g = globalThis as { structuredClone?: <T>(v: T) => T };
if (!g.structuredClone) g.structuredClone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

// A page's globals the reused code reads: a memory localStorage (prefs live
// for the session until the app agent backs them with nsh Storage), a
// window whose only real part is matchMedia's dark-mode query, a document
// with an empty root element.
const g2 = globalThis as Record<string, unknown>;
if (!g2.localStorage) {
  const items = new Map<string, string>();
  g2.localStorage = {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, String(v)),
    removeItem: (k: string) => void items.delete(k),
  };
}
if (!g2.window) {
  g2.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: (query: string) => ({
      matches: query.includes("dark") && colorScheme() === "dark",
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  };
}
if (!g2.document) g2.document = { documentElement: { dataset: {}, style: { setProperty: () => {} } } };

export {};
