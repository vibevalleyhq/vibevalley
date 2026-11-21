import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { placeholderKinds, placeholders } from "@vibevalley/i18n/format";

import { readGlossary, wordProblems } from "../docs/glossary.ts";
import { messageUses } from "./i18n-uses.ts";

const root = join(import.meta.dirname, "../..");
const pkg = join(root, "packages/i18n");
const dictionaries = join(root, "crates/i18n");
const localesDir = join(dictionaries, "locales");
const catalogsFile = join(pkg, "src/catalogs.ts");
const locales = ["zh", "en"] as const;
type Locale = (typeof locales)[number];

interface Nested {
  [k: string]: string | Nested;
}

const han = /\p{Script=Han}/u;
/** Messages every language says the same way (a language's own name): Han in English is meant there. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the locales' own files, checked by this script
const same = new Set((JSON.parse(readFileSync(join(dictionaries, "same.json"), "utf8")) as { keys: string[] }).keys);
const placeholdersOf = (text: string) => placeholders(text).toSorted();

const namespaces = (locale: Locale) =>
  existsSync(join(localesDir, locale))
    ? readdirSync(join(localesDir, locale))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .toSorted()
    : [];

/** Rust-only namespaces (`server.*`, `cli`, `desktop`) stay in `crates/i18n`; TS bundles only UI catalogs. */
const isUiNamespace = (ns: string) => ns === "shared" || ns.startsWith("web.");

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the locales' own files, checked by this script
const readCatalog = (locale: Locale, ns: string): Nested => JSON.parse(readFileSync(join(localesDir, locale, ns + ".json"), "utf8")) as Nested;

function flatten(prefix: string, v: string | Nested, out: Map<string, string>) {
  if (typeof v === "string") out.set(prefix, v);
  else for (const [k, x] of Object.entries(v)) flatten(prefix + "." + k, x, out);
  return out;
}

function messages(locale: Locale, filter: (ns: string) => boolean = () => true): Map<string, string> {
  const out = new Map<string, string>();
  for (const ns of namespaces(locale).filter(filter)) flatten(ns, readCatalog(locale, ns), out);
  return out;
}

const quote = (s: string) => JSON.stringify(s);

function generated(): string {
  const zh = messages("zh", isUiNamespace);
  const all = locales.map((l) => messages(l, isUiNamespace));
  // The catalogs are written in as data, not imported as JSON: every bundler and Node read a .ts the same way.
  const lines = ["// Written by `vpx scripts/gen/i18n.ts gen` from crates/i18n/locales: do not edit.", ""];
  lines.push("/** Each language's catalogs by namespace. */", "export const catalogs = {");
  for (const locale of locales) {
    lines.push(`  ${locale}: {`);
    for (const ns of namespaces(locale).filter(isUiNamespace)) lines.push(`    ${quote(ns)}: ${JSON.stringify(readCatalog(locale, ns))},`);
    lines.push("  },");
  }
  lines.push("};", "", "/** Every key, and the params its zh message names (undefined: none). */", "export interface Messages {");
  for (const [key, text] of [...zh].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    // A message's params are every language's: an English plural may name a count the Chinese does not say.
    const kinds = new Map<string, string>();
    for (const one of [text, ...all.map((m) => m.get(key) ?? "")])
      for (const [n, kind] of placeholderKinds(one)) if (kinds.get(n) === undefined || kind !== "value") kinds.set(n, kind);
    // A select on true is a flag; one on other values (a month's number) takes the value.
    const flag = (n: string) => [text, ...all.map((m) => m.get(key) ?? "")].some((one) => new RegExp(`\\{${n}, select, true \\{`, "u").test(one));
    const typeOf = (n: string, kind: string | undefined) =>
      kind === "plural" || kind === "selectordinal" ? "number" : kind === "select" && flag(n) ? "boolean" : "string | number";
    const names = [...kinds.keys()].toSorted();
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
  execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", "apps", "packages", "crates", "scripts/gen/capabilities.ts"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(
      (f) =>
        (/^(apps|packages)\/[^/]+\/(src|scripts)\/.*\.tsx?$/u.test(f) ||
          /^apps\/[^/]+\/vite\.config\.ts$/u.test(f) ||
          // The Rust server, the command line and the native app say theirs from the same catalogs.
          /^(crates\/[^/]+\/src\/.*|apps\/mac\/src\/.*)\.rs$/u.test(f) ||
          /^apps\/mac\/ui\/(?!build\/).*\.tsx?$/u.test(f) ||
          f === "scripts/gen/capabilities.ts") &&
        !f.endsWith("packages/i18n/src/catalogs.ts") &&
        existsSync(join(root, f)),
    );

const scan = () => sources().flatMap((file) => messageUses(file, readFileSync(join(root, file), "utf8")));

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
    for (const m of readFileSync(join(root, file), "utf8").matchAll(/"([a-z][\w.-]*\.[\w.$/-]+)"/gu)) if (zh.has(m[1]!)) used.add(m[1]!);
  const prefixes = uses.filter((u) => u.prefix).map((u) => u.key);
  for (const u of uses) if (!u.prefix && !zh.has(u.key)) problems.push(`${u.file}:${u.line}: ${u.key} is not in the catalogs`);
  for (const k of zh.keys()) if (!used.has(k) && !prefixes.some((p) => k.startsWith(p))) problems.push(`unused: ${k}`);
  const glossary = readGlossary(readFileSync(join(root, "docs/README.md"), "utf8"));
  for (const locale of locales) problems.push(...wordProblems(glossary, locale, messages(locale)));
  if (!existsSync(catalogsFile) || readFileSync(catalogsFile, "utf8") !== formatted(generated()))
    problems.push("packages/i18n/src/catalogs.ts is stale: run vpx scripts/gen/i18n.ts gen");
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
  default:
    console.log("usage: vpx scripts/gen/i18n.ts gen | scan | check | find <text>");
    process.exit(command ? 1 : 0);
}
