// A message's placeholders: {name} puts a value in as it is; {n, plural, one {…} other {…}} picks by a count (# is the
// count); {n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} picks by an order; {flag, select, true {…}
// other {…}} picks by a value. The branches are messages of their own.

export type Value = string | number | boolean;
export type Params = Readonly<Record<string, Value>>;

/** The parts of a message: text, and placeholders with their branches. */
const kinds = ["plural", "selectordinal", "select"] as const;
type Kind = (typeof kinds)[number];
type Part = string | { readonly name: string; readonly kind?: Kind; readonly cases?: Readonly<Record<string, Part[]>> };

const parsed = new Map<string, Part[]>();

function parse(text: string): Part[] {
  let i = 0;
  const parts = (until: string): Part[] => {
    const out: Part[] = [];
    let buf = "";
    while (i < text.length && !until.includes(text[i]!)) {
      if (text[i] !== "{") {
        buf += text[i++];
        continue;
      }
      const close = placeholderAt(i);
      if (close === undefined) {
        buf += text[i++];
        continue;
      }
      if (buf) out.push(buf);
      buf = "";
      out.push(close);
    }
    if (buf) out.push(buf);
    return out;
  };
  const placeholderAt = (start: number): Part | undefined => {
    const m = /^\{\s*([A-Za-z_$][\w$]*)\s*(?:,\s*(plural|selectordinal|select)\s*,)?/.exec(text.slice(start));
    if (!m) return undefined;
    i = start + m[0].length;
    const kind = kinds.find((k) => k === m[2]);
    if (!kind) {
      if (text[i] !== "}") return void (i = start);
      i++;
      return { name: m[1]! };
    }
    const cases: Record<string, Part[]> = {};
    while (true) {
      const c = /^\s*([^\s{}]+)\s*\{/.exec(text.slice(i));
      if (!c) break;
      i += c[0].length;
      cases[c[1]!] = parts("}");
      i++;
    }
    while (text[i] === " ") i++;
    if (text[i] !== "}") return void (i = start);
    i++;
    return { name: m[1]!, kind, cases };
  };
  return parts("");
}

const plural = new Intl.PluralRules("en");
const ordinal = new Intl.PluralRules("en", { type: "ordinal" });

function render(parts: readonly Part[], params: Params, count?: number): string {
  let out = "";
  for (const p of parts) {
    if (typeof p === "string") out += count === undefined ? p : p.replace(/#/g, String(count));
    else if (!p.kind) out += p.name in params ? String(params[p.name]) : `{${p.name}}`;
    else {
      const v = params[p.name];
      const cases = p.cases ?? {};
      const counted = p.kind === "plural" || p.kind === "selectordinal";
      const rules = p.kind === "selectordinal" ? ordinal : plural;
      const key = counted ? (typeof v === "number" && cases[`=${v}`] ? `=${v}` : rules.select(Number(v))) : String(v);
      const chosen = cases[key] ?? cases.other ?? [];
      out += render(chosen, params, counted ? Number(v) : count);
    }
  }
  return out;
}

export function format(text: string, params: Params): string {
  let parts = parsed.get(text);
  if (!parts) {
    parts = parse(text);
    parsed.set(text, parts);
  }
  return render(parts, params);
}

/** The placeholders a message names, each once, in order, with how each is used. */
export function placeholderKinds(text: string): Map<string, "value" | Kind> {
  const out = new Map<string, "value" | Kind>();
  const walk = (parts: readonly Part[]) => {
    for (const p of parts) {
      if (typeof p === "string") continue;
      if (!out.has(p.name) || p.kind) out.set(p.name, p.kind ?? out.get(p.name) ?? "value");
      for (const c of Object.values(p.cases ?? {})) walk(c);
    }
  };
  walk(parse(text));
  return out;
}

export const placeholders = (text: string): string[] => [...placeholderKinds(text).keys()];
