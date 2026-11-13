// Generates vibevalley-protocol's wire types (src/generated/) from VibeValley's own
// zod schemas. Each schema in packages/protocol/src/**/schema.ts `satisfies
// Codec<T>` of its hand-written shape, so the schemas are the shapes, exactly,
// and zod v4 keeps their full definition at runtime (`_zod.def`). Reading them
// needs no TypeScript compiler.
//
//   crates/vibevalley-protocol/gen/run.sh   (vp run protocol:rust)
//
// Rules:
// - object → struct, camelCase, optional → Option skipped when None, nullable → Option written as null.
// - z.enum / string literals → enum with the exact strings.
// - discriminated unions (and plain unions whose members share a literal key) → internally tagged enums; a named
//   member becomes a newtype variant whose struct leaves the tag out.
// - spreads, extends, Omit and Pick are already expanded in the zod object, so fields are written out.
// - Record<string, T> → BTreeMap; number → i64 when zod says int or the field is a time/count (NUMBER rules), else JsNumber.
// - what does not map is reported (gen/report.txt).

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const outDir = process.argv[3];
if (!root || !outDir) throw new Error("usage: gen.ts <copy from prepare.sh> <out dir>");
const P = `${root}/packages/protocol/src`;

const MODULES = [
  "common",
  "agent",
  "runtime",
  "memory",
  "repo",
  "session",
  "issue",
  "inbox",
  "cron",
  "channel",
  "connector",
  "game",
  "media",
  "voice",
  "artifact",
  "pkm",
  "provider",
  "setting",
  "user",
  "lan",
  "orchestrator",
  "attachment",
  "core",
];

const report: string[] = [];
const note = (s: string) => report.push(s);

// ---------- names: declared consts, shapes' *Values, docs ----------

type Z = any;
const isZod = (v: unknown): v is Z => !!v && typeof v === "object" && "_zod" in (v as object);
const def = (s: Z) => s._zod.def;

interface Named {
  name: string;
  module: string;
  lower?: boolean;
}
const named = new Map<Z, Named>();
const aliases: { name: string; of: Z; module: string }[] = [];
const valuesNames = new Map<string, string>();
const typeDocs = new Map<string, string>();
const fieldDocs = new Map<string, string>();

const filesOf = (m: string, re: RegExp) =>
  readdirSync(join(P, m))
    .filter((f) => re.test(f) && !f.includes(".test."))
    .sort((a, b) => (a === "schema.ts" || a === "shapes.ts" ? 1 : b === "schema.ts" || b === "shapes.ts" ? -1 : a.localeCompare(b)));

const cleanDoc = (raw: string) =>
  raw
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, "").trimEnd())
    .join("\n")
    .trim();

function readDocs(text: string) {
  const re = /(\/\*\*(?:(?!\*\/)[\s\S])*\*\/)\s*export\s+(?:interface|type|const)\s+(\w+)/g;
  for (const m of text.matchAll(re)) typeDocs.set(m[2]!, cleanDoc(m[1]!));
  const iface = /export\s+interface\s+(\w+)[^{]*\{/g;
  for (const m of text.matchAll(iface)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      const c = text[i++];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    const body = text.slice(start, i - 1);
    // Only depth-1 members: drop nested braces' contents.
    let flat = "";
    let d = 0;
    for (const c of body) {
      if (c === "{") d++;
      if (d === 0) flat += c;
      if (c === "}") d--;
    }
    for (const f of flat.matchAll(/(\/\*\*(?:(?!\*\/)[\s\S])*\*\/)\s*(?:readonly\s+)?["']?([\w$]+)["']?\??\s*:/g)) {
      fieldDocs.set(`${m[1]}.${f[2]}`, cleanDoc(f[1]!));
    }
  }
}

for (const m of MODULES) {
  for (const f of filesOf(m, /shapes\.ts$/)) {
    const text = readFileSync(join(P, m, f), "utf8");
    readDocs(text);
    const mod = await import(join(P, m, f));
    for (const [k, v] of Object.entries(mod)) {
      if (k.endsWith("Values") && Array.isArray(v) && v.every((x) => typeof x === "string")) {
        const key = JSON.stringify([...v].sort());
        if (!valuesNames.has(key)) valuesNames.set(key, k.slice(0, -"Values".length));
      }
    }
  }
}
// shapes.ts at the root re-exports constants used by the endpoint table.
readDocs(readFileSync(join(P, "shapes.ts"), "utf8"));

for (const m of MODULES) {
  for (const f of filesOf(m, /schema\.ts$/)) {
    const text = readFileSync(join(P, m, f), "utf8");
    const declared = [...text.matchAll(/^export const (\w+)\s*(?::[^=]+)?=/gm)].map((x) => x[1]!);
    const mod = await import(join(P, m, f));
    for (const name of declared) {
      const v = mod[name];
      if (!isZod(v)) continue;
      if (named.has(v)) {
        aliases.push({ name, of: v, module: m });
        continue;
      }
      named.set(v, { name: name[0]!.toUpperCase() + name.slice(1), module: m, lower: name[0] !== name[0]!.toUpperCase() });
    }
    for (const [k, v] of Object.entries(mod)) {
      if (k.endsWith("Values") && Array.isArray(v) && v.every((x) => typeof x === "string")) {
        const key = JSON.stringify([...v].sort());
        if (!valuesNames.has(key)) valuesNames.set(key, k.slice(0, -"Values".length));
      }
    }
  }
}

// ---------- Rust naming ----------

const RUST_KEYWORDS = new Set(
  "as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn abstract become box do final macro override priv typeof unsized virtual yield try gen".split(
    " ",
  ),
);
const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
const pascal = (s: string) => {
  const w = words(s)
    .map((x) => x[0]!.toUpperCase() + x.slice(1))
    .join("");
  if (!w) return "Empty";
  return /^[0-9]/.test(w) ? `V${w}` : w;
};
const snake = (s: string) => {
  const w = words(s)
    .map((x) => x.toLowerCase())
    .join("_");
  const id = /^[0-9]/.test(w) ? `n${w}` : w || "empty";
  return RUST_KEYWORDS.has(id) ? `r#${id}` : id;
};
// serde's camelCase of a snake ident: what rename_all = "camelCase" writes.
const serdeCamel = (ident: string) => {
  const id = ident.replace(/^r#/, "");
  let out = "";
  let up = false;
  for (const c of id) {
    if (c === "_") up = true;
    else {
      out += up ? c.toUpperCase() : c;
      up = false;
    }
  }
  return out;
};
const str = (s: string) => JSON.stringify(s);

const used = new Set<string>();
const HAND_WRITTEN = new Set(["JsNumber", "BizCode", "Envelope", "ApiError", "Next", "LitTrue", "LitFalse", "Caller", "Endpoint", "Op", "Subscription"]);
// Anonymous types whose derived name reads badly.
const RENAMES: Record<string, string> = { AssignmentExecutions: "Execution", SuggestionEventTag: "SuggestionEventKind" };
function claim(want: string): string {
  want = RENAMES[want] ?? want;
  let name = want;
  for (let i = 2; used.has(name) || HAND_WRITTEN.has(name); i++) name = `${want}${i}`;
  used.add(name);
  return name;
}
// Upper-cased lower-case consts (pkmBacklinks) give way to the type of that name.
for (const n of [...named.values()].sort((a, b) => Number(!!a.lower) - Number(!!b.lower))) {
  if (used.has(n.name)) {
    if (!n.lower) note(`duplicate schema name ${n.name} (${n.module})`);
    n.name = claim(`${n.name}Schema`);
  } else used.add(n.name);
}

// ---------- numbers ----------

// A number is an i64 when zod says int, or the field is a time or a count; JsNumber (written as JS writes it) otherwise.
const INT_FIELD =
  /^(at|seq|revision|time|since|until|created|updated|expires|deadline|started|ended|lastRun|hiredAt|when|after|before|number|runs|count|total|attempt|of|index|rank|port|pid|size|bytes|line|lines|column|call|under|input|output|cacheRead|tokens|version|tries|limit|offset|page|pages|days|hours|minutes|seconds|ms|width|height|level|x|y|day|week|month|year|hour|minute|streak|stars|missed|unread|mentions|depth|position|order|from|to|added|removed|insertions|deletions|ahead|behind|commits|files|step|steps|turns|max|min|cap|ttl|criterion|read|replies|replyTo|archived|deleted|edited|pinned|rev|baseRev|nowRev|merged|harvested|hired|failed|pending|lastInbound|lastSeen|first|last|maxSessions|maxWorking|station|tier|need|xp|coins|recalled|chars|resolved|every|blanks|code|comments|counts|bestStreak|toolsThisRun|next)$|(At|Ms|Seq|Revision|Count|Index|Bytes|Lines|Tokens|Size|Total|Number|Since|Until|Day|Days|Time)$/;
const numberFields: string[] = [];
function numberType(s: Z, owner: string, key: string | undefined): string {
  const d = def(s);
  const checks: Z[] = d.checks ?? [];
  const int = d.format === "safeint" || d.format === "int32" || d.format === "uint32" || checks.some((c: Z) => c?._zod?.def?.format === "safeint");
  const t = int || (key !== undefined && INT_FIELD.test(key)) ? "i64" : "JsNumber";
  numberFields.push(`${t.padEnd(8)} ${owner}.${key ?? "?"}${int ? " (int)" : ""}`);
  return t;
}

// ---------- union discriminators ----------

const literalOf = (s: Z): unknown[] | undefined => {
  if (!isZod(s)) return undefined;
  const d = def(s);
  if (d.type === "literal") return d.values;
  if (d.type === "enum") return Object.values(d.entries);
  if (d.type === "readonly" || d.type === "pipe") return literalOf(d.innerType ?? d.in);
  return undefined;
};
const objectOptions = (u: Z): Z[] => {
  const d = def(u);
  return Object.values(d.options) as Z[];
};
function discriminatorOf(u: Z): string | undefined {
  const d = def(u);
  if (d.discriminator) return d.discriminator;
  const opts = objectOptions(u);
  if (!opts.every((o) => def(o).type === "object")) return undefined;
  const keys = Object.keys(def(opts[0]).shape);
  for (const k of keys) {
    const vals = opts.map((o) => literalOf(def(o).shape[k] ?? {_zod:{def:{type:"x"}}}));
    if (vals.every((v) => v && v.length === 1)) {
      const flat = vals.map((v) => JSON.stringify(v![0]));
      if (new Set(flat).size === flat.length) return k;
    }
  }
  return undefined;
}
// Flattened members of a tagged union: nested unions on the same key are inlined.
function members(u: Z, key: string): Z[] {
  return objectOptions(u).flatMap((o) => (def(o).type === "union" && discriminatorOf(o) === key ? members(o, key) : [o]));
}

// The tag a named member struct leaves out (it is the variant's).
const tagOf = new Map<Z, string>();
const seen = new Set<Z>();
function prewalk(s: Z) {
  if (!isZod(s) || seen.has(s)) return;
  seen.add(s);
  const d = def(s);
  switch (d.type) {
    case "object":
      for (const v of Object.values(d.shape)) prewalk(v);
      break;
    case "union": {
      const key = discriminatorOf(s);
      for (const o of Object.values(d.options)) prewalk(o);
      const bad = key ? members(s, key).filter((o) => def(o).type !== "object" || !literalOf(def(o).shape[key])) : [];
      if (bad.length) throw new Error(`union on ${key}: members without a literal tag: ${bad.map((o) => JSON.stringify(def(o).shape ? Object.keys(def(o).shape) : def(o).type)).join("; ")} in ${named.get(s)?.name}`);
      if (key && members(s, key).every((o) => typeof literalOf(def(o).shape[key])![0] === "string")) {
        for (const o of members(s, key)) if (named.has(o)) tagOf.set(o, key);
      }
      break;
    }
    case "array":
      prewalk(d.element);
      break;
    case "record":
      prewalk(d.keyType);
      prewalk(d.valueType);
      break;
    case "optional":
    case "nullable":
    case "default":
    case "readonly":
    case "catch":
    case "nonoptional":
    case "prefault":
      prewalk(d.innerType);
      break;
    case "pipe":
      prewalk(d.in);
      break;
    case "lazy":
      prewalk(d.getter());
      break;
    case "tuple":
      for (const i of d.items) prewalk(i);
      break;
    case "intersection":
      prewalk(d.left);
      prewalk(d.right);
      break;
  }
}

// ---------- emission ----------

const items = new Map<string, string[]>(MODULES.map((m) => [m, []]));
const emitted = new Map<Z, string>();
const onStack = new Set<Z>();

const DERIVE = "#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]";
const ENUM_DERIVE = "#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]";

const docLines = (doc: string | undefined, indent = "") =>
  doc
    ? doc
        .split("\n")
        .map((l) => `${indent}///${l ? " " + l : ""}`)
        .join("\n") + "\n"
    : "";

interface Ctx {
  module: string;
  owner: string;
  key?: string;
  /** under Vec/BTreeMap/Option-in-box: no Box needed for recursion */
  boxed?: boolean;
  /** naming a union's member: its tag is the variant's */
  inUnion?: boolean;
}

/** The Rust type of schema `s`, emitting whatever named items it needs. */
function ty(s: Z, hint: string, ctx: Ctx): string {
  const n = named.get(s);
  if (n) {
    if (onStack.has(s) && !ctx.boxed) return `Box<${n.name}>`;
    define(s);
    if (tagOf.has(s) && !ctx.inUnion) return only(s, n);
    return n.name;
  }
  const d = def(s);
  switch (d.type) {
    case "string":
      return "String";
    case "number":
      return numberType(s, ctx.owner, ctx.key);
    case "int":
      return "i64";
    case "boolean":
      return "bool";
    case "unknown":
    case "any":
      return "serde_json::Value";
    case "null":
      return "()";
    case "literal":
      return literalType(s, hint, ctx);
    case "enum":
      return enumType(s, Object.values(d.entries) as string[], hint, ctx);
    case "array":
      return `Vec<${ty(d.element, hint, { ...ctx, boxed: true })}>`;
    case "record": {
      const k = def(d.keyType).type === "string" ? "String" : ty(d.keyType, `${hint}Key`, ctx);
      return `BTreeMap<${k}, ${ty(d.valueType, hint, { ...ctx, boxed: true })}>`;
    }
    case "optional":
    case "nullable":
    case "default":
      return `Option<${ty(d.innerType, hint, ctx)}>`;
    case "readonly":
    case "catch":
    case "nonoptional":
    case "prefault":
      return ty(d.innerType, hint, ctx);
    case "pipe":
      // The wire carries what goes in (a branded id is a string; JSON text is a string).
      return ty(d.in, hint, ctx);
    case "lazy":
      return ty(d.getter(), hint, ctx);
    case "tuple":
      return `(${d.items.map((i: Z, k: number) => ty(i, `${hint}${k}`, ctx)).join(", ")},)`;
    case "object":
    case "union":
    case "intersection": {
      if (emitted.has(s)) return emitted.get(s)!;
      const name = claim(hint);
      defineAs(s, name, ctx.module);
      return name;
    }
    default:
      note(`unmapped zod type ${d.type} at ${ctx.owner}.${ctx.key ?? ""}: serde_json::Value`);
      return "serde_json::Value";
  }
}

// A union member named on its own (a field that takes only that member): a one-variant tagged enum, so the tag is written.
const onlys = new Map<Z, string>();
function only(s: Z, n: Named): string {
  if (onlys.has(s)) return onlys.get(s)!;
  const key = tagOf.get(s)!;
  const tags = literalOf(def(s).shape[key]) as string[];
  const name = claim(`${n.name}Only`);
  onlys.set(s, name);
  const vn = variantNames(tags);
  items.get(n.module)!.push(
    `/// \`${n.name}\` where nothing else is taken: its \`${key}\` written.\n${DERIVE}\n#[serde(tag = ${str(key)})]\npub enum ${name} {\n${tags.map((t, i) => `    #[serde(rename = ${str(t)})]\n    ${vn[i]}(${n.name}),`).join("\n")}\n}\n`,
  );
  return name;
}

function literalType(s: Z, hint: string, ctx: Ctx): string {
  const vals: unknown[] = def(s).values;
  if (vals.every((v) => typeof v === "string")) return enumType(s, vals as string[], hint, ctx);
  if (vals.every((v) => typeof v === "boolean")) {
    if (vals.length === 1) return vals[0] ? "LitTrue" : "LitFalse";
    return "bool";
  }
  if (vals.every((v) => typeof v === "number")) return vals.every((v) => Number.isInteger(v)) ? "i64" : "JsNumber";
  note(`mixed literal at ${ctx.owner}.${ctx.key}: serde_json::Value`);
  return "serde_json::Value";
}

const enumsByValues = new Map<string, string>();
function enumType(s: Z, values: string[], hint: string, ctx: Ctx): string {
  if (emitted.has(s)) return emitted.get(s)!;
  const key = JSON.stringify([...values].sort());
  const existing = enumsByValues.get(key);
  if (existing) {
    emitted.set(s, existing);
    return existing;
  }
  const want = valuesNames.get(key);
  const name = claim(want && !used.has(want) ? want : hint);
  emitted.set(s, name);
  enumsByValues.set(key, name);
  writeEnum(name, values, ctx.module, typeDocs.get(name));
  return name;
}

function variantNames(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    let n = pascal(v);
    if (/^[+-]/.test(v)) n = (v.startsWith("-") ? "Minus" : "Plus") + n;
    while (out.includes(n)) n += "_";
    out.push(n);
  }
  return out;
}

function writeEnum(name: string, values: string[], module: string, doc?: string) {
  const vn = variantNames(values);
  const body = values.map((v, i) => `    #[serde(rename = ${str(v)})]\n    ${vn[i]},`).join("\n");
  items.get(module)!.push(
    `${docLines(doc)}${ENUM_DERIVE}\npub enum ${name} {\n${body}\n}\n\nimpl ${name} {\n    pub const ALL: [${name}; ${values.length}] = [${vn.map((v) => `${name}::${v}`).join(", ")}];\n\n    /// The string on the wire.\n    pub fn as_str(self) -> &'static str {\n        match self {\n${values.map((v, i) => `            ${name}::${vn[i]} => ${str(v)},`).join("\n")}\n        }\n    }\n}\n`,
  );
}

function define(s: Z) {
  if (emitted.has(s)) return;
  const n = named.get(s)!;
  const d = def(s);
  if (d.type === "object" || d.type === "union" || d.type === "intersection") {
    defineAs(s, n.name, n.module);
  } else if (d.type === "enum") {
    emitted.set(s, n.name);
    const values = Object.values(d.entries) as string[];
    const key = JSON.stringify([...values].sort());
    if (!enumsByValues.has(key)) enumsByValues.set(key, n.name);
    writeEnum(n.name, values, n.module, typeDocs.get(n.name));
  } else {
    emitted.set(s, n.name);
    onStack.add(s);
    // A named non-object (an id, a list, a literal): an alias of its Rust type.
    const inner = d.type === "literal" && (d.values as unknown[]).every((v) => typeof v === "string") ? literalNamed(s, n) : ty(Object.create(s, {}) as Z, n.name, { module: n.module, owner: n.name });
    onStack.delete(s);
    if (inner !== n.name) items.get(n.module)!.push(`${docLines(typeDocs.get(n.name))}pub type ${n.name} = ${inner};\n`);
  }
}

function literalNamed(s: Z, n: Named): string {
  writeEnum(n.name, def(s).values, n.module, typeDocs.get(n.name));
  return n.name;
}

interface Field {
  key: string;
  schema: Z;
}

function fieldLines(owner: string, docOwner: string, fields: Field[], ctx: Ctx, indent: string, inVariant: boolean): string {
  const out: string[] = [];
  for (const { key, schema } of fields) {
    let s = schema;
    let optional = false;
    let nullable = false;
    let defaulted = false;
    for (;;) {
      const t = def(s).type;
      if (t === "optional") optional = true;
      else if (t === "default" || t === "prefault") defaulted = true;
      else if (t === "nullable") nullable = true;
      else if (t !== "readonly" && t !== "catch") break;
      s = def(s).innerType;
    }
    const ident = snake(key);
    const hint = owner + pascal(key);
    const inner = ty(s, hint, { ...ctx, owner, key, boxed: false });
    const attrs: string[] = [];
    if (serdeCamel(ident) !== key) attrs.push(`rename = ${str(key)}`);
    let t = inner;
    let always = false;
    if ((optional || defaulted) && nullable) {
      t = `Option<Option<${inner}>>`;
      attrs.push(`default`, `with = "::serde_with::rust::double_option"`);
    } else if (optional || defaulted) {
      t = `Option<${inner}>`;
      if (defaulted) attrs.push("default");
    } else if (nullable) {
      t = `Option<${inner}>`;
      always = true;
    }
    if (defaulted) note(`default (read as optional) at ${owner}.${key}`);
    const doc = fieldDocs.get(`${docOwner}.${key}`);
    let line = docLines(doc, indent);
    if (always) line += `${indent}#[serialize_always]\n`;
    if (attrs.length) line += `${indent}#[serde(${attrs.join(", ")})]\n`;
    line += `${indent}${inVariant ? "" : "pub "}${ident}: ${t},`;
    out.push(line);
  }
  return out.join("\n");
}

const shapeFields = (o: Z, skip?: string): Field[] =>
  Object.entries(def(o).shape as Record<string, Z>)
    .filter(([k]) => k !== skip)
    .map(([key, schema]) => ({ key, schema }));

function catchallNote(o: Z, owner: string) {
  const c = def(o).catchall;
  if (c && def(c).type !== "never") note(`object ${owner} accepts unknown keys (catchall ${def(c).type}); extra keys are dropped`);
}

function defineAs(s: Z, name: string, module: string) {
  emitted.set(s, name);
  onStack.add(s);
  const d = def(s);
  const doc = typeDocs.get(name);
  const ctx: Ctx = { module, owner: name };
  let text: string;
  if (d.type === "object") {
    catchallNote(s, name);
    const tag = tagOf.get(s);
    const fields = shapeFields(s, tag);
    const body = fieldLines(name, name, fields, ctx, "    ", false);
    // Default when every field has a natural one (no enum, struct or union without one).
    const types = [...body.matchAll(/^\s*pub [\w#]+: (.+),$/gm)].map((m) => m[1]!);
    const defaultable = types.every((t) => /^(Option<|Vec<|BTreeMap<|String$|bool$|i64$|JsNumber$|serde_json::Value$)/.test(t));
    const derive = defaultable ? DERIVE.replace("Clone,", "Clone, Default,") : DERIVE;
    text = `${docLines(doc)}#[skip_serializing_none]\n${derive}\n#[serde(rename_all = "camelCase")]\npub struct ${name} {\n${body}${body ? "\n" : ""}}\n`;
  } else if (d.type === "intersection") {
    const l = def(d.left);
    const r = def(d.right);
    if (l.type !== "object" || r.type !== "object") {
      note(`intersection ${name} of ${l.type} & ${r.type}: serde_json::Value`);
      text = `pub type ${name} = serde_json::Value;\n`;
    } else {
      const body = fieldLines(name, name, [...shapeFields(d.left), ...shapeFields(d.right)], ctx, "    ", false);
      text = `${docLines(doc)}#[skip_serializing_none]\n${DERIVE}\n#[serde(rename_all = "camelCase")]\npub struct ${name} {\n${body}\n}\n`;
    }
  } else {
    text = unionText(s, name, doc, ctx);
  }
  onStack.delete(s);
  items.get(module)!.push(text);
}

function unionText(s: Z, name: string, doc: string | undefined, ctx: Ctx): string {
  const key = discriminatorOf(s);
  if (key) {
    const pairs = members(s, key).flatMap((o) => (literalOf(def(o).shape[key]) ?? []).map((tag) => ({ o, tag })));
    const tags = pairs.map((p) => p.tag);
    if (tags.every((t) => typeof t === "string")) {
      const vn = variantNames(tags as string[]);
      const variants = pairs.map(({ o }, i) => {
        const tag = tags[i] as string;
        const n = named.get(o);
        if (n) {
          const inner = ty(o, n.name, { ...ctx, key: tag, boxed: true, inUnion: true });
          return `    #[serde(rename = ${str(tag)})]\n    ${vn[i]}(${inner}),`;
        }
        catchallNote(o, `${name}::${vn[i]}`);
        const fields = shapeFields(o, key);
        const owner = `${name}${vn[i]}`;
        if (!fields.length) return `    #[serde(rename = ${str(tag)})]\n    ${vn[i]} {},`;
        return `    #[serde(rename = ${str(tag)}, rename_all = "camelCase")]\n    ${vn[i]} {\n${fieldLines(owner, name, fields, ctx, "        ", true)}\n    },`;
      });
      return `${docLines(doc)}#[skip_serializing_none]\n${DERIVE}\n#[serde(tag = ${str(key)})]\npub enum ${name} {\n${variants.join("\n")}\n}\n`;
    }
    note(`union ${name} is told apart by a non-string "${key}" (${tags.map((t) => JSON.stringify(t)).join(", ")}): untagged, the tag kept as a literal field`);
  } else {
    note(`union ${name} has no discriminator: untagged`);
  }
  // Untagged: each member as it is, tag fields (if any) kept as literal-typed fields.
  const opts = objectOptions(s);
  const vnames: string[] = [];
  const variants = opts.map((o, i) => {
    const n = named.get(o);
    const od = def(o);
    let v: string;
    if (n) v = n.name;
    else if (od.type === "object") {
      const lit = key ? literalOf(od.shape[key]) : undefined;
      v = lit ? pascal(String(lit[0])) : pascal(Object.keys(od.shape)[0] ?? `V${i}`);
    } else v = pascal(od.type);
    while (vnames.includes(v)) v += "_";
    vnames.push(v);
    if (!n && od.type === "object") {
      catchallNote(o, `${name}::${v}`);
      return `    ${v} {\n${fieldLines(`${name}${v}`, name, shapeFields(o), ctx, "        ", true)}\n    },`;
    }
    return `    ${v}(${ty(o, `${name}${v}`, { ...ctx, boxed: true })}),`;
  });
  return `${docLines(doc)}#[skip_serializing_none]\n${DERIVE}\n#[serde(untagged)]\npub enum ${name} {\n${variants.join("\n")}\n}\n`;
}

// ---------- endpoints and subscriptions ----------

interface EndpointRow {
  op: string;
  module: string;
  about: string[];
  can: string[];
  dryRun?: string;
  input?: string;
  result?: string;
  doc?: string;
}

const opName = (op: string) => pascal(op.replace(/\./g, " "));
const endpointRows: EndpointRow[] = [];
const rawEndpoints: { op: string; module: string; about: string[]; can: string[]; dryRun?: string; input?: Z; result?: Z }[] = [];

const apiDocs = new Map<string, string>();
for (const m of MODULES) {
  let text: string;
  try {
    text = readFileSync(join(P, m, "api.ts"), "utf8");
  } catch {
    continue;
  }
  for (const x of text.matchAll(/(\/\*\*(?:(?!\*\/)[\s\S])*\*\/)\s*readonly\s+"([\w.]+)"\s*:/g)) apiDocs.set(x[2]!, cleanDoc(x[1]!));
}

for (const m of MODULES) {
  let mod: Record<string, unknown>;
  try {
    mod = await import(join(P, m, "api.ts"));
  } catch {
    continue;
  }
  const list = mod[`${m}Endpoints`] as { op: string; about: string[]; can: string[]; dryRun?: string; input?: Z; result?: Z }[] | undefined;
  if (!list) {
    note(`module ${m} has no ${m}Endpoints`);
    continue;
  }
  for (const e of list) rawEndpoints.push({ ...e, module: m });
}

const rpc = await import(join(P, "rpc.ts"));
const subs = Object.entries(rpc.subscriptions as Record<string, { payload: Z; event: Z }>);

// Tags first: a member struct must know it leaves its tag out before anything names it.
for (const s of named.keys()) prewalk(s);
for (const e of rawEndpoints) {
  if (e.input) prewalk(e.input);
  if (e.result) prewalk(e.result);
}
for (const [, sub] of subs) {
  prewalk(sub.payload);
  prewalk(sub.event);
}
for (const [s, n] of named) {
  const d = def(s);
  const vals = d.type === "enum" ? (Object.values(d.entries) as string[]) : d.type === "literal" && d.values.every((v: unknown) => typeof v === "string") ? d.values : undefined;
  if (vals) {
    const key = JSON.stringify([...vals].sort());
    if (!enumsByValues.has(key)) enumsByValues.set(key, n.name);
  }
}

// Every named schema, in source order per module, whether or not an endpoint reaches it.
for (const s of named.keys()) define(s);
for (const e of rawEndpoints) {
  const row: EndpointRow = { op: e.op, module: e.module, about: [...e.about], can: [...e.can], dryRun: e.dryRun, doc: apiDocs.get(e.op) };
  const base = opName(e.op);
  if (e.input) row.input = ty(e.input, `${base}Input`, { module: e.module, owner: `${base}Input`, boxed: true });
  if (e.result) row.result = ty(e.result, `${base}Result`, { module: e.module, owner: `${base}Result`, boxed: true });
  endpointRows.push(row);
}
const subscriptionRows = subs.map(([name, sub]) => {
  const base = opName(name);
  return {
    name,
    payload: ty(sub.payload, `${base}Payload`, { module: "core", owner: `${base}Payload`, boxed: true }),
    event: ty(sub.event, `${base}Event`, { module: "core", owner: `${base}Event`, boxed: true }),
  };
});
for (const a of aliases) {
  const target = named.get(a.of)!.name;
  if (a.name !== target && !used.has(a.name)) {
    used.add(a.name);
    items.get(a.module)!.push(`pub type ${a.name} = ${target};\n`);
  }
}


// ---------- samples: wire values for every emitted type ----------

// Each value is built from the schema, checked with zod's safeParse, and written as it goes on the wire (the input, not
// the parsed output). The Rust test reads each into its type and must write the same JSON back.
let counter = 0;
const next = () => ++counter;
const STRING_FORMATS: Record<string, () => string> = {
  email: () => `a${next()}@example.com`,
  url: () => `https://example.com/${next()}`,
  uuid: () => "123e4567-e89b-42d3-a456-426614174000",
  datetime: () => "2026-11-13T09:00:00.000Z",
  date: () => "2026-11-13",
};
const checksOf = (s: Z): Z[] => (def(s).checks ?? []).map((c: Z) => c?._zod?.def ?? c);
function bounds(s: Z) {
  let lo: number | undefined;
  let hi: number | undefined;
  let pattern = "";
  let format: string | undefined;
  for (const c of checksOf(s)) {
    if (c.check === "greater_than") lo = c.value + (c.inclusive ? 0 : 1);
    if (c.check === "less_than") hi = c.value - (c.inclusive ? 0 : 1);
    if (c.check === "min_length") lo = c.minimum;
    if (c.check === "max_length") hi = c.maximum;
    if (c.check === "length_equals") lo = hi = c.length;
    if (c.check === "string_format") {
      format = c.format;
      if (c.pattern) pattern = String(c.pattern);
    }
  }
  return { lo, hi, pattern, format };
}
function sample(s: Z, full: boolean, pick: number, depth: number): unknown {
  const d = def(s);
  switch (d.type) {
    case "string": {
      const b = bounds(s);
      const f = d.format ?? b.format;
      if (f && STRING_FORMATS[f]) return STRING_FORMATS[f]();
      if (b.pattern.includes("[0-9a-f]{64}")) return next().toString(16).padStart(64, "0");
      if (b.pattern.includes("\\d{4}-\\d{2}-\\d{2}")) return "2026-11-13";
      let v = `s${next()}`;
      if (b.lo !== undefined) v = v.padEnd(b.lo, "x");
      if (b.hi !== undefined) v = v.slice(0, Math.max(b.hi, 0));
      return v;
    }
    case "number":
    case "int": {
      const b = bounds(s);
      const lo = b.lo ?? 0;
      const hi = b.hi ?? lo + 1_000_000;
      return Math.ceil(lo) + (next() % Math.max(1, Math.floor(hi - Math.ceil(lo)) + 1));
    }
    case "boolean":
      return (next() & 1) === 0;
    case "unknown":
    case "any":
      return { any: [1, "x"] };
    case "null":
      return null;
    case "literal":
      return d.values[pick % d.values.length];
    case "enum": {
      const v = Object.values(d.entries);
      return v[pick % v.length];
    }
    case "array":
      return depth > 4 ? [] : [sample(d.element, full, pick, depth + 1)];
    case "record": {
      if (depth > 4) return {};
      const kd = def(d.keyType);
      if (kd.type === "enum") return Object.fromEntries(Object.values(kd.entries).map((k) => [String(k), sample(d.valueType, full, pick, depth + 1)]));
      const k = kd.type === "string" ? `k${next()}` : sample(d.keyType, full, pick, depth + 1);
      return { [String(k)]: sample(d.valueType, full, pick, depth + 1) };
    }
    case "optional":
    case "default":
    case "prefault":
      return sample(d.innerType, full, pick, depth);
    case "nullable":
      return full ? sample(d.innerType, full, pick, depth) : null;
    case "readonly":
    case "catch":
    case "nonoptional":
      return sample(d.innerType, full, pick, depth);
    case "pipe": {
      // JSON text read as x: the wire carries the text.
      if (def(d.in).type === "pipe" && def(def(d.in).out).type === "transform") return JSON.stringify(sample(d.out, full, pick, depth));
      return sample(d.in, full, pick, depth);
    }
    case "lazy":
      return sample(d.getter(), full, pick, depth);
    case "tuple":
      return d.items.map((i: Z) => sample(i, full, pick, depth + 1));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d.shape as Record<string, Z>)) {
        const optional = ["optional", "default", "prefault"].includes(def(v).type);
        if (optional && (!full || depth > 3)) continue;
        out[k] = sample(v, full, pick, depth + 1);
      }
      return out;
    }
    case "intersection":
      return { ...(sample(d.left, full, pick, depth) as object), ...(sample(d.right, full, pick, depth) as object) };
    case "union": {
      const opts = Object.values(d.options) as Z[];
      return sample(opts[pick % opts.length], full, pick, depth);
    }
    default:
      return null;
  }
}
const unionWidth = (s: Z): number => {
  const d = def(s);
  if (d.type === "union") return Object.values(d.options).reduce((n: number, o) => n + unionWidth(o as Z), 0) as number;
  if (d.type === "enum") return Object.values(d.entries).length;
  if (d.type === "literal") return d.values.length;
  return 1;
};
const samples: Record<string, Record<string, unknown[]>> = {};
const sampled = new Set<string>();
let sampleCount = 0;
// A union's member struct leaves its tag to the union: it is sampled through the union (or its ...Only wrapper).
for (const [s, name] of [...[...emitted.entries()].filter(([s]) => !tagOf.has(s)), ...onlys.entries()]) {
  if (sampled.has(name) || /^(i64|JsNumber|String|Vec<|Option<|BTreeMap<)/.test(name)) continue;
  sampled.add(name);
  const module = named.get(s)?.module ?? [...items.entries()].find(([, list]) => list.some((t) => new RegExp(`pub (struct|enum|type) ${name}\\b`).test(t)))?.[0] ?? "core";
  const values: unknown[] = [];
  const width = Math.max(1, Math.min(unionWidth(s), 64));
  for (let pick = 0; pick < width; pick++) {
    for (const full of [true, false]) {
      const v = sample(s, full, pick, 0);
      const r = s.safeParse(v);
      if (r.success) {
        if (!values.some((x) => JSON.stringify(x) === JSON.stringify(v))) values.push(v);
      } else note(`sample of ${name} does not parse: ${r.error.issues.map((i: Z) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 200)}`);
    }
  }
  if (values.length) {
    (samples[module] ??= {})[name] = values;
    sampleCount += values.length;
  }
}

// ---------- write ----------

mkdirSync(outDir, { recursive: true });
const header = (what: string) =>
  `// @generated by crates/vibevalley-protocol/gen/gen.ts from packages/protocol (${what}). Do not edit.\n`;
for (const m of MODULES) {
  const body = items.get(m)!.join("\n");
  writeFileSync(
    join(outDir, `${m}.rs`),
    `${header(`packages/protocol/src/${m}`)}\n#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]\n\n#[allow(unused_imports)]\nuse std::collections::BTreeMap;\n\nuse serde::{Deserialize, Serialize};\nuse serde_with::skip_serializing_none;\n\n#[allow(unused_imports)]\nuse super::*;\n#[allow(unused_imports)]\nuse crate::wire::*;\n\n${body}`,
  );
}

const callers = ["user", "remote", "orchestrator", "session"];
// In ops and subscriptions the unit structs shadow same-named types: name the types by path.
const STD = new Set(["Vec", "Option", "BTreeMap", "Box", "String"]);
const qualified = (t: string) => t.replace(/\b([A-Z]\w*)\b/g, (m) => (STD.has(m) ? m : `t::${m}`));
const rs: string[] = [];
rs.push(header("packages/protocol/src/*/api.ts, rpc.ts"));
rs.push(`
use crate::wire::{Caller, Endpoint};

mod t {
    pub use crate::generated::*;
    #[allow(unused_imports)]
    pub use crate::wire::*;
}

/// Every endpoint, in VibeValley's order (\`packages/protocol/src/api.ts\`).
pub const ENDPOINTS: &[Endpoint] = &[
${endpointRows
  .map(
    (r) =>
      `    Endpoint { op: ${str(r.op)}, module: ${str(r.module)}, about: &[${r.about.map(str).join(", ")}], can: &[${r.can
        .map((c) => {
          if (!callers.includes(c)) throw new Error(`unknown caller ${c}`);
          return `Caller::${pascal(c)}`;
        })
        .join(", ")}], dry_run: ${r.dryRun ? `Some(${str(r.dryRun)})` : "None"}, input: ${r.input ? `Some(${str(r.input)})` : "None"}, result: ${r.result ? `Some(${str(r.result)})` : "None"} },`,
  )
  .join("\n")}
];

/// Each endpoint as a type: its name, input and result.
pub mod ops {
    use super::t;
    use crate::wire::Op;
    #[allow(unused_imports)]
    use std::collections::BTreeMap;
${endpointRows
  .map(
    (r) =>
      `${docLines(r.doc, "    ")}    pub struct ${opName(r.op)};\n    impl Op for ${opName(r.op)} {\n        const NAME: &'static str = ${str(r.op)};\n        type Input = ${qualified(r.input ?? "()")};\n        type Result = ${qualified(r.result ?? "()")};\n    }`,
  )
  .join("\n")}
}

/// rpc.ts' subscriptions: each one's payload and event.
pub mod subscriptions {
    use super::t;
    use crate::wire::Subscription;
${subscriptionRows
  .map(
    (r) =>
      `    pub struct ${opName(r.name)};\n    impl Subscription for ${opName(r.name)} {\n        const NAME: &'static str = ${str(r.name)};\n        type Payload = ${qualified(r.payload)};\n        type Event = ${qualified(r.event)};\n    }`,
  )
  .join("\n")}
}
`);
writeFileSync(
  join(outDir, "endpoints.rs"),
  rs.join(""),
);

const goldenDir = join(outDir, "..", "..", "golden", "schema");
mkdirSync(goldenDir, { recursive: true });
for (const [m, byName] of Object.entries(samples)) writeFileSync(join(goldenDir, `${m}.json`), JSON.stringify(byName, null, 1) + "\n");
const names = [...sampled].filter((n) => Object.values(samples).some((b) => n in b)).sort();
writeFileSync(
  join(outDir, "registry.rs"),
  `${header("type registry")}
/// Reads \`value\` as the generated type \`name\` and writes it back: the
/// round trip the golden tests hold every sample to. \`None\` when no type has
/// that name.
pub fn round_trip(name: &str, value: serde_json::Value) -> Option<Result<serde_json::Value, String>> {
    fn rt<T: serde::Serialize + serde::de::DeserializeOwned>(v: serde_json::Value) -> Result<serde_json::Value, String> {
        let t: T = serde_json::from_value(v).map_err(|e| e.to_string())?;
        serde_json::to_value(&t).map_err(|e| e.to_string())
    }
    Some(match name {
${names.map((n) => `        ${str(n)} => rt::<super::${n}>(value),`).join("\n")}
        _ => return None,
    })
}
`,
);

writeFileSync(
  join(outDir, "mod.rs"),
  `${header("module index")}\n${[...MODULES, "endpoints"].map((m) => `pub mod ${m};`).join("\n")}\npub mod registry;\n\n${[...MODULES, "endpoints"].map((m) => `pub use ${m}::*;`).join("\n")}\n`,
);

writeFileSync(join(outDir, "..", "..", "gen", "report.txt"), `What gen.ts could not map exactly:\n\n${[...new Set(report)].map((r) => `- ${r}`).join("\n")}\n`);
writeFileSync(join(outDir, "..", "..", "gen", "numbers.txt"), `Every number field and its Rust type:\n\n${[...new Set(numberFields)].sort().join("\n")}\n`);
console.log(`samples: ${sampleCount} of ${names.length} types,`, `types: ${emitted.size}, endpoints: ${endpointRows.length}, subscriptions: ${subscriptionRows.length}, notes: ${new Set(report).size}`);
