// The owner-facing words (packages/i18n): `vpx scripts/i18n.ts <command>`.
//
//   gen                 writes packages/i18n/src/catalogs.ts (the catalogs and every key's params) from locales/
//   scan                lists each key used in code (t("…")) and where; a template key counts as its prefix
//   check               fails on a key used but missing, a key nobody uses, a language with keys zh lacks or lacking
//                       zh's, placeholders that differ, Han in English, English that is zh word for word, a stale gen
//   find <text>         the keys whose zh or en contains text
//   migrate <words.ts>  moves a word table into a catalog and its call sites to t("…"); what it cannot, it lists
//
// Namespaces are the host and the module: apps/web/src/features/setting/words.ts is web.setting.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { format, placeholderKinds, placeholders } from "../packages/i18n/src/format.ts";

const root = join(import.meta.dirname, "..");
const pkg = join(root, "packages/i18n");
const localesDir = join(pkg, "locales");
const catalogsFile = join(pkg, "src/catalogs.ts");
const locales = ["zh", "en"] as const;
type Locale = (typeof locales)[number];

interface Nested {
  [k: string]: string | Nested;
}

const han = /\p{Script=Han}/u;
/** Messages every language says the same way (a language's own name): Han in English is meant there. */
const same = new Set((JSON.parse(readFileSync(join(pkg, "same.json"), "utf8")) as { keys: string[] }).keys);
const placeholdersOf = (text: string) => placeholders(text).sort();

const namespaces = (locale: Locale) =>
  existsSync(join(localesDir, locale))
    ? readdirSync(join(localesDir, locale))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .sort()
    : [];

const readCatalog = (locale: Locale, ns: string): Nested => JSON.parse(readFileSync(join(localesDir, locale, ns + ".json"), "utf8")) as Nested;

function flatten(prefix: string, v: string | Nested, out: Map<string, string>) {
  if (typeof v === "string") out.set(prefix, v);
  else for (const [k, x] of Object.entries(v)) flatten(prefix + "." + k, x, out);
  return out;
}

function messages(locale: Locale): Map<string, string> {
  const out = new Map<string, string>();
  for (const ns of namespaces(locale)) flatten(ns, readCatalog(locale, ns), out);
  return out;
}

const quote = (s: string) => JSON.stringify(s);

function generated(): string {
  const zh = messages("zh");
  const all = locales.map(messages);
  // The catalogs are written in as data, not imported as JSON: every bundler and Node read a .ts the same way.
  const lines = ["// Written by `vpx scripts/i18n.ts gen` from packages/i18n/locales: do not edit.", ""];
  lines.push("/** Each language's catalogs by namespace. */", "export const catalogs = {");
  for (const locale of locales) {
    lines.push(`  ${locale}: {`);
    for (const ns of namespaces(locale)) lines.push(`    ${quote(ns)}: ${JSON.stringify(readCatalog(locale, ns))},`);
    lines.push("  },");
  }
  lines.push("};", "", "/** Every key, and the params its zh message names (undefined: none). */", "export interface Messages {");
  for (const [key, text] of [...zh].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // A message's params are every language's: an English plural may name a count the Chinese does not say.
    const kinds = new Map<string, string>();
    for (const one of [text, ...all.map((m) => m.get(key) ?? "")])
      for (const [n, kind] of placeholderKinds(one)) if (kinds.get(n) === undefined || kind !== "value") kinds.set(n, kind);
    // A select on true is a flag; one on other values (a month's number) takes the value.
    const flag = (n: string) => [text, ...all.map((m) => m.get(key) ?? "")].some((one) => new RegExp(`\\{${n}, select, true \\{`).test(one));
    const typeOf = (n: string, kind: string | undefined) =>
      kind === "plural" || kind === "selectordinal" ? "number" : kind === "select" && flag(n) ? "boolean" : "string | number";
    const names = [...kinds.keys()].sort();
    lines.push(`  ${quote(key)}: ${names.length > 0 ? `{ ${names.map((n) => `readonly ${n}: ${typeOf(n, kinds.get(n))}`).join("; ")} }` : "undefined"};`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

function gen() {
  writeFileSync(catalogsFile, generated());
  execFileSync("vp", ["fmt", relative(root, catalogsFile)], { cwd: root, stdio: "ignore" });
}

const sources = () =>
  execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", "apps", "packages"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(
      (f) =>
        (/^(apps|packages)\/[^/]+\/src\/.*\.tsx?$/.test(f) || /^apps\/[^/]+\/vite\.config\.ts$/.test(f)) &&
        !f.endsWith("packages/i18n/src/catalogs.ts") &&
        existsSync(join(root, f)),
    );

interface Use {
  readonly file: string;
  readonly line: number;
  readonly key: string;
  readonly prefix: boolean;
}

function scan(): Use[] {
  const uses: Use[] = [];
  for (const file of sources()) {
    const text = readFileSync(join(root, file), "utf8");
    if (!text.includes("t(")) continue;
    const lineOf = (i: number) => text.slice(0, i).split("\n").length;
    for (const m of text.matchAll(/\b(?:t|maybe)\(\s*"([a-z][\w.-]*\.[\w.$/-]+)"/g)) uses.push({ file, line: lineOf(m.index), key: m[1]!, prefix: false });
    for (const m of text.matchAll(/\b(?:t|maybe)\(\s*`([a-z][\w.-]*\.[^`$]*)\$\{/g)) uses.push({ file, line: lineOf(m.index), key: m[1]!, prefix: true });
  }
  return uses;
}

function check(): string[] {
  const problems: string[] = [];
  const zh = messages("zh");
  for (const locale of locales) {
    if (locale === "zh") continue;
    const other = messages(locale);
    for (const k of zh.keys()) if (!other.has(k)) problems.push(`${locale}: missing ${k}`);
    for (const [k, v] of other) {
      const source = zh.get(k);
      if (source === undefined) {
        problems.push(`${locale}: ${k} is not in zh`);
        continue;
      }
      if (placeholdersOf(v).some((p) => !placeholdersOf(source).includes(p)) && placeholdersOf(source).some((p) => !placeholdersOf(v).includes(p)))
        problems.push(`${locale}: ${k} says {${placeholdersOf(v).join("}, {")}}, zh {${placeholdersOf(source).join("}, {")}}`);
      if (same.has(k)) continue;
      if (locale === "en" && han.test(v)) problems.push(`en: ${k} has Chinese in it: ${v}`);
      if (v === source && han.test(source)) problems.push(`${locale}: ${k} is zh word for word`);
    }
  }
  const uses = scan();
  const used = new Set(uses.filter((u) => !u.prefix).map((u) => u.key));
  // A key may also be picked before the call (t(ok ? "a" : "b")): a literal that names one counts as using it.
  for (const file of sources())
    for (const m of readFileSync(join(root, file), "utf8").matchAll(/"([a-z][\w.-]*\.[\w.$/-]+)"/g)) if (zh.has(m[1]!)) used.add(m[1]!);
  const prefixes = uses.filter((u) => u.prefix).map((u) => u.key);
  for (const u of uses) if (!u.prefix && !zh.has(u.key)) problems.push(`${u.file}:${u.line}: ${u.key} is not in the catalogs`);
  for (const k of zh.keys()) if (!used.has(k) && !prefixes.some((p) => k.startsWith(p))) problems.push(`unused: ${k}`);
  if (!existsSync(catalogsFile) || readFileSync(catalogsFile, "utf8") !== formatted(generated()))
    problems.push("packages/i18n/src/catalogs.ts is stale: run vpx scripts/i18n.ts gen");
  return problems;
}

/** What gen would leave on disk, formatted as vp fmt leaves it. */
function formatted(text: string): string {
  const tmp = join(pkg, "src", ".catalogs.check.ts");
  writeFileSync(tmp, text);
  try {
    execFileSync("vp", ["fmt", relative(root, tmp)], { cwd: root, stdio: "ignore" });
    return readFileSync(tmp, "utf8");
  } finally {
    unlinkSync(tmp);
  }
}

function find(text: string) {
  const needle = text.toLowerCase();
  const en = messages("en");
  for (const [k, v] of messages("zh")) {
    const e = en.get(k) ?? "";
    if (v.toLowerCase().includes(needle) || e.toLowerCase().includes(needle)) console.log(`${k}\n  zh ${v}\n  en ${e}`);
  }
}

/** web.setting for apps/web/src/features/setting/words.ts; shared for packages/protocol/src/words. */
function namespaceOf(file: string): string {
  const rel = relative(root, file).replace(/\\/g, "/");
  if (rel.startsWith("packages/protocol/src/words")) return "shared";
  const m = /^apps\/([^/]+)\/src\/(.*?)\/?words\.ts$/.exec(rel);
  if (!m) throw new Error(`not a word table: ${rel}`);
  const parts = m[2]!.split("/").filter((p) => p !== "" && p !== "features");
  return [m[1]!, ...parts].join(".");
}

const sentinel = (i: number) => `\u0001${i}\u0001`;

function paramNames(fn: Function): string[] {
  const src = fn.toString();
  const m = /^\s*(?:async\s*)?(?:function\s*[\w$]*\s*)?\(([^)]*)\)/.exec(src) ?? /^\s*([\w$]+)\s*=>/.exec(src);
  if (!m) return [];
  return m[1]!
    .split(",")
    .map((p) => p.replace(/=.*$/, "").replace(/:.*$/, "").trim())
    .filter(Boolean);
}

/** A function whose answer only puts its params in a fixed text: that text with {name} for each. */
function templateOf(fn: Function): string | undefined {
  const names = paramNames(fn);
  if (names.length === 0 || names.length !== fn.length) return undefined;
  const call = (args: unknown[]) => {
    try {
      const r = (fn as (...a: unknown[]) => unknown)(...args);
      return typeof r === "string" ? r : undefined;
    } catch {
      return undefined;
    }
  };
  const a = call(names.map((_, i) => sentinel(i)));
  if (a === undefined || /undefined|NaN|\[object /.test(a)) return undefined;
  let text = a;
  names.forEach((n, i) => (text = text.split(sentinel(i)).join(`{${n}}`)));
  if (text.includes("\u0001")) return undefined;
  // A template answers every value by putting it in as it is: a count that picks a plural, a flag or an optional value
  // that picks a branch, or a param read as an object answers otherwise.
  const filled = (v: string) => names.reduce((s, n) => s.split(`{${n}}`).join(v), text);
  for (const v of [1, 2, 7, "x", "", undefined]) if (call(names.map(() => v)) !== filled(String(v))) return undefined;
  return text;
}

/** A function that picks by one param, as a plural on a count or a select on a flag; kept only if formatting it gives
 * what the function gives for every sample. */
function choiceOf(fn: Function): string | undefined {
  const names = paramNames(fn);
  if (names.length === 0 || names.length !== fn.length) return undefined;
  const call = (args: unknown[]) => {
    try {
      const r = (fn as (...a: unknown[]) => unknown)(...args);
      return typeof r === "string" && !/undefined|NaN|\[object /.test(r) ? r : undefined;
    } catch {
      return undefined;
    }
  };
  const named = (r: string) => names.reduce((s, n, i) => s.split(sentinel(i)).join(`{${n}}`), r);
  const agrees = (message: string, samples: unknown[][]) =>
    samples.every((args) => {
      const want = call(args);
      const params = Object.fromEntries(names.map((n, i) => [n, args[i] as string | number | boolean]));
      return want !== undefined && format(message, params) === want;
    });
  const others = (i: number, v: unknown) => names.map((_, j) => (j === i ? v : sentinel(j)));
  for (let i = 0; i < names.length; i++) {
    const n = names[i]!;
    const one = call(others(i, 1));
    const many = call(others(i, 7));
    if (one !== undefined && many !== undefined) {
      const body = (r: string, count: number) => named(r).split(String(count)).join("#");
      const message = `{${n}, plural, one {${body(one, 1)}} other {${body(many, 7)}}}`;
      // Large values too: a count of milliseconds can read the same for every small one.
      const samples = [0, 1, 2, 5, 11, 21, 100, 1000, 61_000, 3_600_000].map((c) => others(i, c));
      if (body(one, 1) !== body(many, 7) && agrees(message, samples)) return message;
    }
    const yes = call(others(i, true));
    const no = call(others(i, false));
    // A param put into the text as it is prints true or false: that is a value, not a flag.
    // A flag: whatever truthy value comes, the same text (a count or a delay that only looks like one shows itself).
    const truthy = [7, 5000, "x"].every((v) => call(others(i, v)) === yes);
    if (yes !== undefined && no !== undefined && yes !== no && truthy && !/true|false/.test(yes + no)) {
      const message = `{${n}, select, true {${named(yes)}} other {${named(no)}}}`;
      if (agrees(message, [others(i, true), others(i, false)])) return message;
    }
  }
  return undefined;
}

interface Converted {
  readonly catalog: Nested;
  /** Keys under the namespace that are templates, and their params in call order. */
  readonly params: Map<string, string[]>;
  readonly skipped: string[];
}

function convert(zh: unknown, en: unknown): { zh: Converted; en: Nested } {
  const params = new Map<string, string[]>();
  const skipped: string[] = [];
  const out = { zh: {} as Nested, en: {} as Nested };
  const walk = (z: unknown, e: unknown, path: string[], zo: Nested, eo: Nested) => {
    for (const [k, zv] of Object.entries(z as object)) {
      const ev = (e as Record<string, unknown> | undefined)?.[k];
      const at = [...path, k];
      if (typeof zv === "string" && typeof ev === "string") {
        zo[k] = zv;
        eo[k] = ev;
      } else if (typeof zv === "function" && typeof ev === "function") {
        const zt = templateOf(zv) ?? choiceOf(zv);
        const et = templateOf(ev) ?? choiceOf(ev);
        const zn = paramNames(zv);
        if (zt !== undefined && et !== undefined && paramNames(ev).join() === zn.join()) {
          zo[k] = zt;
          eo[k] = et;
          params.set(at.join("."), zn);
        } else skipped.push(at.join("."));
      } else if (Array.isArray(zv) && Array.isArray(ev) && zv.length === ev.length && [...zv, ...ev].every((x) => typeof x === "string")) {
        // A list of sentences or names is kept by index: weekdays.0 … weekdays.6.
        zo[k] = Object.fromEntries(zv.map((x, i) => [String(i), x]));
        eo[k] = Object.fromEntries(ev.map((x, i) => [String(i), x as string]));
      } else if (typeof zv === "object" && zv !== null && !Array.isArray(zv)) {
        zo[k] = {};
        eo[k] = {};
        walk(zv, ev, at, zo[k], eo[k]);
        if (Object.keys(zo[k]).length === 0) {
          delete zo[k];
          delete eo[k];
        }
      } else skipped.push(at.join("."));
    }
  };
  walk(zh, en, [], out.zh, out.en);
  return { zh: { catalog: out.zh, params, skipped }, en: out.en };
}

const has = (o: Nested, path: string[]): "leaf" | "branch" | undefined => {
  let v: string | Nested | undefined = o;
  for (const p of path) {
    if (typeof v !== "object" || !(p in v)) return undefined;
    v = v[p];
  }
  return typeof v === "string" ? "leaf" : "branch";
};

/** Splits call arguments at their top-level commas. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      cur += c;
      if (c === "\\") cur += s[++i] ?? "";
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The end of a call's arguments: the index after its closing paren. */
function closing(text: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

async function migrate(file: string) {
  const abs = join(root, file);
  const ns = namespaceOf(abs);
  const locale = (await import(pathToFileURL(join(pkg, "src/locale.ts")).href)) as { setLocale: (l: Locale) => void };
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  const accessorName = Object.keys(mod).find((k) => typeof mod[k] === "function" && /(ording|Words)$|^wording$/.test(k));
  if (!accessorName) throw new Error(`no word table in ${file}`);
  const accessor = mod[accessorName] as () => unknown;
  locale.setLocale("zh");
  const zh = accessor();
  locale.setLocale("en");
  const en = accessor();
  locale.setLocale("zh");
  const { zh: converted, en: enCatalog } = convert(zh, en);
  for (const [l, catalog] of [
    ["zh", converted.catalog],
    ["en", enCatalog],
  ] as const) {
    mkdirSync(join(localesDir, l), { recursive: true });
    writeFileSync(join(localesDir, l, ns + ".json"), JSON.stringify(catalog, null, 2) + "\n");
  }

  const left: string[] = converted.skipped.map((p) => `${file}: ${p} has logic: write it as messages by hand`);
  const callers = execFileSync("git", ["grep", "-l", accessorName + "()", "--", "apps", "packages"], { cwd: root, encoding: "utf8" })
    .split("\n")
    // Tables in different apps share names (voiceWording): only the app that has this one calls it.
    .filter(
      (f) => /\.tsx?$/.test(f) && f !== file && (file.startsWith("packages/") || f.split("/").slice(0, 2).join("/") === file.split("/").slice(0, 2).join("/")),
    );
  const chain = new RegExp(`\\b${accessorName}\\(\\)((?:\\.[A-Za-z_$][\\w$]*)+)`, "g");
  /** Rewrites every chain in `text` that ends in a moved message; arguments are rewritten the same way first. */
  const rewrite = (text: string, caller: string, base: number): { out: string; changed: boolean } => {
    let out = "";
    let at = 0;
    let changed = false;
    for (const m of text.matchAll(chain)) {
      if (m.index < at) continue;
      const keyPath = m[1]!.slice(1).split(".");
      const kind = has(converted.catalog, keyPath);
      const end = m.index + m[0].length;
      const key = `${ns}.${keyPath.join(".")}`;
      const lineNo = base + text.slice(0, m.index).split("\n").length - 1;
      if (kind === "leaf" && converted.params.has(keyPath.join("."))) {
        if (text[end] !== "(") {
          left.push(`${caller}:${lineNo}: ${key} is passed as a function`);
          continue;
        }
        const close = closing(text, end);
        const inner = rewrite(text.slice(end + 1, close - 1), caller, lineNo);
        const args = splitArgs(inner.out);
        const names = converted.params.get(keyPath.join("."))!;
        if (args.length !== names.length) {
          left.push(`${caller}:${lineNo}: ${key} called with ${args.length} of ${names.length} params`);
          continue;
        }
        const fields = names.map((n, i) => (args[i] === n ? n : `${n}: ${args[i]}`)).join(", ");
        out += text.slice(at, m.index) + `t(${quote(key)}, { ${fields} })`;
        at = close;
        changed = true;
      } else if (kind === "leaf") {
        out += text.slice(at, m.index) + `t(${quote(key)})`;
        at = end;
        changed = true;
      } else left.push(`${caller}:${lineNo}: ${accessorName}()${m[1]} is ${kind === "branch" ? "a whole table" : "not moved"}`);
    }
    return { out: out + text.slice(at), changed };
  };
  for (const caller of callers) {
    const path = join(root, caller);
    const { out, changed } = rewrite(readFileSync(path, "utf8"), caller, 1);
    let text: string;
    for (const m of out.matchAll(new RegExp(`\\b${accessorName}\\(\\)`, "g")))
      left.push(`${caller}:${out.slice(0, m.index).split("\n").length}: ${accessorName}() used another way`);
    if (!changed) continue;
    text = out;
    // The table's import goes with its last use.
    if (!new RegExp(`\\b${accessorName}\\b`).test(text.replace(/^import [^;]*;$/gm, "")))
      text = text.replace(new RegExp(`^import \\{([^}]*)\\} from "([^"]+)";$`, "gm"), (whole, names: string, from: string) => {
        const kept = names
          .split(",")
          .map((n) => n.trim())
          .filter((n) => n !== "" && n !== accessorName);
        return kept.length ===
          names
            .split(",")
            .map((n) => n.trim())
            .filter(Boolean).length
          ? whole
          : kept.length > 0
            ? `import { ${kept.join(", ")} } from "${from}";`
            : "";
      });
    if (!/import \{[^}]*\bt\b[^}]*\} from "@vibevalley\/i18n"/.test(text)) text = `import { t } from "@vibevalley/i18n";\n` + text;
    writeFileSync(path, text);
  }
  gen();
  console.log(`${file} → locales/{zh,en}/${ns}.json (${flatten(ns, converted.catalog, new Map()).size} messages)`);
  for (const l of left) console.log("  " + l);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "gen":
    gen();
    break;
  case "scan":
    for (const u of scan()) console.log(`${u.key}${u.prefix ? "*" : ""}\t${u.file}:${u.line}`);
    break;
  case "check": {
    const problems = check();
    for (const p of problems) console.log(p);
    console.log(problems.length > 0 ? `i18n: ${problems.length} problems` : `i18n: ${messages("zh").size} messages ok`);
    if (problems.length > 0) process.exit(1);
    break;
  }
  case "find":
    find(rest.join(" "));
    break;
  case "migrate":
    for (const f of rest) await migrate(f);
    break;
  default:
    console.log("usage: vpx scripts/i18n.ts gen | scan | check | find <text> | migrate <words.ts>…");
    process.exit(command ? 1 : 0);
}
