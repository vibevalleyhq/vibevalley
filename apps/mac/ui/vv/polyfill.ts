import { colorScheme, host } from "nsh";

// What nsh's JS engine (still in 0.6.0) lacks and the reused VibeValley code calls.
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

const intlObj: object | undefined = typeof Intl === "object" ? Intl : undefined;
if (intlObj && Reflect.get(intlObj, "PluralRules") === undefined) Reflect.set(intlObj, "PluralRules", PluralRules);

// The engine's DateTimeFormat speaks English whatever the locale: Chinese
// dates are written here (年 月 日, 周五, 24-hour time); others go through.
const Native = typeof Intl === "object" ? Intl.DateTimeFormat : undefined;
if (intlObj && Native && /^[A-Za-z]/u.test(new Native("zh", { weekday: "short" }).format(0))) {
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
      const none =
        o.year === undefined &&
        o.month === undefined &&
        o.day === undefined &&
        o.weekday === undefined &&
        o.hour === undefined &&
        o.minute === undefined &&
        o.dateStyle === undefined &&
        o.timeStyle === undefined;
      const date = none || o.dateStyle !== undefined ? { year: "numeric", month: "numeric", day: "numeric" } : o;
      let out = "";
      if (date.year !== undefined) out += `${d.getFullYear()}年`;
      if (date.month !== undefined) out += date.month === "2-digit" ? `${two(d.getMonth() + 1)}月` : `${d.getMonth() + 1}月`;
      if (date.day !== undefined) out += date.day === "2-digit" ? `${two(d.getDate())}日` : `${d.getDate()}日`;
      if (o.weekday !== undefined)
        out +=
          (out ? " " : "") +
          (o.weekday === "narrow" ? weekdays[d.getDay()] : o.weekday === "long" ? `星期${weekdays[d.getDay()]}` : `周${weekdays[d.getDay()]}`);
      if (o.hour !== undefined || o.minute !== undefined || o.timeStyle !== undefined) out += (out ? " " : "") + `${two(d.getHours())}:${two(d.getMinutes())}`;
      return out;
    }
    formatToParts(at?: number | Date) {
      return this.zh ? [{ type: "literal", value: this.format(at) }] : this.#native.formatToParts(at);
    }
    resolvedOptions() {
      return this.#native.resolvedOptions();
    }
  }
  Reflect.set(intlObj, "DateTimeFormat", ChineseDates);
}

if (typeof Reflect.get(globalThis, "structuredClone") !== "function") {
  Reflect.set(globalThis, "structuredClone", (v: unknown): unknown => (v === undefined ? v : JSON.parse(JSON.stringify(v))));
}

// A page's globals the reused code reads: a memory localStorage (prefs live
// for the session until the app agent backs them with nsh Storage), a
// window whose only real part is matchMedia's dark-mode query, a document
// with an empty root element.
if (Reflect.get(globalThis, "localStorage") === undefined) {
  const items = new Map<string, string>();
  Reflect.set(globalThis, "localStorage", {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  });
}
if (Reflect.get(globalThis, "window") === undefined) {
  Reflect.set(globalThis, "window", {
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: (query: string) => ({
      matches: query.includes("dark") && colorScheme() === "dark",
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}
if (Reflect.get(globalThis, "document") === undefined) {
  Reflect.set(globalThis, "document", { documentElement: { dataset: {}, style: { setProperty: () => {} } } });
}

// Synchronous `crypto.getRandomValues` and `crypto.randomUUID` when `nsh-platform-gpui`
// is built without its heavy `"crypto"` feature. Seeded with 256-bit OS entropy injected
// by Rust via `host.params.randomSeed` and expanded with RFC 8439 ChaCha20.
function installCryptoPolyfill() {
  const existingRaw: unknown = Reflect.get(globalThis, "crypto");
  const existing = typeof existingRaw === "object" && existingRaw !== null ? existingRaw : undefined;
  if (existing && typeof Reflect.get(existing, "getRandomValues") === "function" && typeof Reflect.get(existing, "randomUUID") === "function") return;

  const key = new Uint32Array(8);
  const seedHex = typeof host.params.randomSeed === "string" ? host.params.randomSeed : "";
  if (/^[0-9a-f]{64}$/iu.test(seedHex)) {
    for (let i = 0; i < 8; i++) key[i] = parseInt(seedHex.slice(i * 8, i * 8 + 8), 16) >>> 0;
  } else {
    const now = Date.now();
    for (let i = 0; i < 8; i++) key[i] = ((Math.random() * 0x1_0000_0000) ^ (now + i * 0x9e37_79b9)) >>> 0;
  }

  let counter = 1;
  const nonce = new Uint32Array([0x243f_6a88, 0x85a3_08d3, (Date.now() & 0xffff_ffff) >>> 0]);
  const state = new Uint32Array(16);
  const work = new Uint32Array(16);
  const block = new Uint8Array(64);
  let pos = 64;

  const rotl = (v: number, n: number) => ((v << n) | (v >>> (32 - n))) >>> 0;
  const qr = (w: Uint32Array, a: number, b: number, c: number, d: number) => {
    w[a] = (w[a] + w[b]) >>> 0;
    w[d] = rotl(w[d] ^ w[a], 16);
    w[c] = (w[c] + w[d]) >>> 0;
    w[b] = rotl(w[b] ^ w[c], 12);
    w[a] = (w[a] + w[b]) >>> 0;
    w[d] = rotl(w[d] ^ w[a], 8);
    w[c] = (w[c] + w[d]) >>> 0;
    w[b] = rotl(w[b] ^ w[c], 7);
  };

  const refill = () => {
    state[0] = 0x6170_7865;
    state[1] = 0x3320_646e;
    state[2] = 0x7962_2d32;
    state[3] = 0x6b20_6574;
    for (let i = 0; i < 8; i++) state[4 + i] = key[i];
    state[12] = counter >>> 0;
    counter = (counter + 1) >>> 0;
    if (counter === 0) nonce[0] = (nonce[0] + 1) >>> 0;
    state[13] = nonce[0];
    state[14] = nonce[1];
    state[15] = nonce[2];
    work.set(state);
    for (let r = 0; r < 10; r++) {
      qr(work, 0, 4, 8, 12);
      qr(work, 1, 5, 9, 13);
      qr(work, 2, 6, 10, 14);
      qr(work, 3, 7, 11, 15);
      qr(work, 0, 5, 10, 15);
      qr(work, 1, 6, 11, 12);
      qr(work, 2, 7, 8, 13);
      qr(work, 3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i++) {
      const v = (work[i] + state[i]) >>> 0;
      block[i * 4] = v & 0xff;
      block[i * 4 + 1] = (v >>> 8) & 0xff;
      block[i * 4 + 2] = (v >>> 16) & 0xff;
      block[i * 4 + 3] = (v >>> 24) & 0xff;
    }
    pos = 0;
  };

  const getRandomValues = <T extends ArrayBufferView>(array: T): T => {
    const out = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < out.length; i++) {
      if (pos >= 64) refill();
      out[i] = block[pos++];
    }
    return array;
  };

  const randomUUID = (): string => {
    const bytes = getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = "";
    for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };

  const target: object = existing ?? {};
  if (typeof Reflect.get(target, "getRandomValues") !== "function") Reflect.set(target, "getRandomValues", getRandomValues);
  if (typeof Reflect.get(target, "randomUUID") !== "function") Reflect.set(target, "randomUUID", randomUUID);
  Reflect.set(globalThis, "crypto", target);
}

installCryptoPolyfill();
