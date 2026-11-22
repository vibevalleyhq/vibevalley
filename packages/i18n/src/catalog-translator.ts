import { catalogs } from "./catalogs";
import { format, type Params } from "./format";
import { setTranslator } from "./index";
import type { Locale } from "./locale";

interface Nested {
  readonly [k: string]: string | Nested;
}

const tables = new Map<Locale, ReadonlyMap<string, string>>();

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

export function catalogTranslate(locale: Locale, key: string, params?: Params): string {
  const text = table(locale).get(key) ?? table("zh").get(key) ?? key;
  return params ? format(text, params) : text;
}

setTranslator(catalogTranslate);
