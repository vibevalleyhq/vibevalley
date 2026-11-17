import { type DefaultTreeAdapterTypes as P, parse, parseFragment } from "parse5";

import { t } from "@vibevalley/i18n";
import type { HtmlAnchor } from "@vibevalley/protocol";

const libraries = ["https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"];

/** Where an HTML artifact may load from besides its own inline code. */
const htmlSources = {
  script: libraries,
  style: [...libraries, "https://fonts.googleapis.com"],
  font: [...libraries, "https://fonts.gstatic.com"],
} as const;

interface At {
  readonly node: number;
  readonly from: number;
  readonly to: number;
}

const hidden = new Set(["head", "script", "style", "template", "noscript", "textarea", "title"]);
const reference = /^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);?/iu;
const space = /\s/u;
const squash = (s: string) => s.replace(/\s+/gu, " ");
const bare = (s: string) => s.replace(/\s+/gu, "");

function decoded(ref: string): string {
  const n = parseFragment(ref).childNodes[0];
  return n && "value" in n && n.nodeName === "#text" ? n.value : ref;
}

function pageText(source: string): { text: string; at: At[] } {
  const chars: { c: string; at: At }[] = [];
  let node = 0;
  const walk = (nodes: readonly P.ChildNode[]) => {
    for (const n of nodes) {
      if ("tagName" in n) {
        if (!hidden.has(n.tagName)) walk(n.childNodes);
        continue;
      }
      const loc = n.sourceCodeLocation;
      if (n.nodeName !== "#text" || !loc) continue;
      node += 1;
      const raw = source.slice(loc.startOffset, loc.endOffset);
      for (let i = 0; i < raw.length;) {
        const ref = raw[i] === "&" ? reference.exec(raw.slice(i))?.[0] : undefined;
        const written = ref ?? raw[i] ?? "";
        for (const c of (ref ? decoded(ref) : written).split(""))
          chars.push({ c, at: { node, from: loc.startOffset + i, to: loc.startOffset + i + written.length } });
        i += written.length;
      }
    }
  };
  walk(parse(source, { sourceCodeLocationInfo: true }).childNodes);
  let text = "";
  const at: At[] = [];
  for (const ch of chars) {
    const last = at.at(-1);
    if (space.test(ch.c) && text.endsWith(" ") && last) {
      at[at.length - 1] = { node: last.node === ch.at.node ? last.node : -1, from: last.from, to: ch.at.to };
      continue;
    }
    text += space.test(ch.c) ? " " : ch.c;
    at.push(ch.at);
  }
  return { text, at };
}

const escaped = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export type HtmlEdited = { readonly ok: true; readonly source: string } | { readonly ok: false; readonly why: string };

export function htmlEdit(source: string, anchor: HtmlAnchor, text: string): HtmlEdited {
  const refused = (why: string): HtmlEdited => ({ ok: false, why });
  const exact = squash(anchor.exact).trim();
  if (exact === "") return refused(t("server.artifact.edit.empty"));
  if (squash(text).trim() === exact) return refused(t("server.artifact.edit.same"));
  const page = pageText(source);
  const found: number[] = [];
  for (let k = page.text.indexOf(exact); k >= 0; k = page.text.indexOf(exact, k + 1)) found.push(k);
  if (found.length === 0) return refused(t("server.artifact.edit.notFound", { words: exact }));
  const [prefix, suffix] = [bare(anchor.prefix), bare(anchor.suffix)];
  const fits = (k: number) =>
    bare(page.text.slice(Math.max(0, k - 4 * prefix.length - 64), k)).endsWith(prefix) &&
    bare(page.text.slice(k + exact.length, k + exact.length + 4 * suffix.length + 64)).startsWith(suffix);
  const chosen = found.length === 1 ? found : found.filter(fits);
  const k = chosen[0];
  if (chosen.length !== 1 || k === undefined) return refused(t("server.artifact.edit.many", { words: exact, n: found.length }));
  const first = page.at[k];
  const last = page.at[k + exact.length - 1];
  if (!first || !last || first.node < 0 || first.node !== last.node) return refused(t("server.artifact.edit.crosses", { words: exact }));
  return { ok: true, source: source.slice(0, first.from) + escaped(text) + source.slice(last.to) };
}

type Need = "script" | "style" | "font" | "inline" | "link";

export type HtmlRefusal =
  | { readonly kind: "load"; readonly need: Need; readonly line: number; readonly url: string }
  | { readonly kind: "form"; readonly line: number; readonly url: string }
  | { readonly kind: "refresh"; readonly line: number }
  | { readonly kind: "base"; readonly line: number }
  | { readonly kind: "frame"; readonly line: number; readonly tag: string };

export interface HtmlWarning {
  readonly line: number;
  readonly call: string;
}

export interface HtmlCheck {
  readonly refused: readonly HtmlRefusal[];
  readonly warned: readonly HtmlWarning[];
}

const hosts: Record<Need, readonly string[]> = {
  script: htmlSources.script,
  style: htmlSources.style,
  font: htmlSources.font,
  inline: [],
  link: [...new Set([...htmlSources.script, ...htmlSources.style, ...htmlSources.font])],
};

function allowed(url: string, need: Need): boolean {
  const u = url.trim();
  if (u === "" || u.startsWith("#")) return true;
  if (/^(?:data|blob):/iu.test(u)) return need === "inline" || need === "font";
  try {
    return hosts[need].includes(new URL(u).origin);
  } catch (e) {
    if (e instanceof TypeError) return false;
    throw e;
  }
}

const frames = new Set(["iframe", "frame", "frameset", "object", "embed", "portal", "fencedframe"]);
const inlineSources: Record<string, readonly string[]> = {
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  image: ["href"],
  use: ["href"],
};
const scriptTypes = new Set(["", "module", "text/javascript", "application/javascript"]);
const network = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/gu;
const imports = [/\bimport\s*(?:[\w*{}\s,$]+?\s*from\s*)?["'](https?:\/\/[^"']+)["']/gu, /\bimport\s*\(\s*["'](https?:\/\/[^"']+)["']/gu];

function linkNeed(rel: string, as: string): Need | undefined {
  const rels = rel.toLowerCase().split(/\s+/u);
  if (rels.includes("stylesheet")) return "style";
  if (rels.some((r) => r === "icon" || r === "apple-touch-icon")) return "inline";
  if (rels.some((r) => r === "preload" || r === "modulepreload" || r === "prefetch"))
    return as === "font" ? "font" : as === "style" ? "style" : as === "image" ? "inline" : "script";
  if (rels.some((r) => r === "preconnect" || r === "dns-prefetch")) return "link";
  return undefined;
}

function srcsetUrls(v: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < v.length) {
    while (i < v.length && /[\s,]/u.test(v[i] ?? "")) i += 1;
    let j = i;
    while (j < v.length && !/\s/u.test(v[j] ?? "")) j += 1;
    const url = v.slice(i, j);
    if (url.endsWith(",")) i = j;
    else {
      const next = v.indexOf(",", j);
      i = next < 0 ? v.length : next + 1;
    }
    if (url.replace(/,+$/u, "") !== "") out.push(url.replace(/,+$/u, ""));
  }
  return out;
}

const blank = (s: string) => s.replace(/[^\n]/gu, " ");
const lineAt = (text: string, at: number) => text.slice(0, at).split("\n").length - 1;

function cssLoads(css: string): { need: Need; at: number; url: string }[] {
  const out: { need: Need; at: number; url: string }[] = [];
  let text = css.replace(/\/\*[\s\S]*?\*\//gu, blank);
  for (const m of text.matchAll(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1/giu)) out.push({ need: "style", at: m.index, url: m[2] ?? "" });
  text = text.replace(/@import[^;]*;?/giu, blank);
  const faces = [...text.matchAll(/@font-face\s*\{[^}]*\}/giu)].map((m) => [m.index, m.index + m[0].length] as const);
  for (const m of text.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/giu))
    out.push({ need: faces.some(([a, b]) => m.index >= a && m.index < b) ? "font" : "inline", at: m.index, url: m[2] ?? "" });
  return out;
}

const attrOf = (el: P.Element, name: string) => el.attrs.find((a) => a.name === name)?.value;
const isElement = (n: P.ChildNode): n is P.Element => "tagName" in n;
const textOf = (el: P.Element) => el.childNodes.map((n) => ("value" in n && n.nodeName === "#text" ? n.value : "")).join("");

export function htmlCheck(source: string): HtmlCheck {
  const refused: HtmlRefusal[] = [];
  const warned: HtmlWarning[] = [];
  const load = (need: Need, line: number, url: string) => {
    if (!allowed(url, need)) refused.push({ kind: "load", need, line, url: url.trim() });
  };
  const visit = (el: P.Element) => {
    const at = el.sourceCodeLocation;
    const line = at?.startLine ?? 1;
    const attrLine = (name: string) => at?.attrs?.[name]?.startLine ?? line;
    const tag = el.tagName.toLowerCase();
    if (frames.has(tag)) refused.push({ kind: "frame", line, tag });
    for (const name of inlineSources[tag] ?? []) {
      const v = attrOf(el, name);
      if (v === undefined) continue;
      const urls = name === "srcset" ? srcsetUrls(v) : [v];
      for (const u of urls) load("inline", attrLine(name), u);
    }
    if (tag === "input" && attrOf(el, "type")?.toLowerCase() === "image") {
      const v = attrOf(el, "src");
      if (v !== undefined) load("inline", attrLine("src"), v);
    }
    if (tag === "link") {
      const need = linkNeed(attrOf(el, "rel") ?? "", (attrOf(el, "as") ?? "").toLowerCase());
      const href = attrOf(el, "href");
      if (need && href !== undefined) load(need, attrLine("href"), href);
    }
    if (tag === "script") {
      const src = attrOf(el, "src") ?? attrOf(el, "href");
      if (src !== undefined) load("script", attrLine(attrOf(el, "src") === undefined ? "href" : "src"), src);
      else if (scriptTypes.has((attrOf(el, "type") ?? "").trim().toLowerCase())) {
        const code = textOf(el);
        const first = el.childNodes[0]?.sourceCodeLocation?.startLine ?? line;
        for (const re of imports) for (const m of code.matchAll(re)) load("script", first + lineAt(code, m.index), m[1] ?? "");
        for (const m of code.matchAll(network)) {
          const call = m[1] ?? "";
          if (!warned.some((w) => w.call === call)) warned.push({ line: first + lineAt(code, m.index), call });
        }
      }
    }
    if (tag === "style") {
      const css = textOf(el);
      const first = el.childNodes[0]?.sourceCodeLocation?.startLine ?? line;
      for (const l of cssLoads(css)) load(l.need, first + lineAt(css, l.at), l.url);
    }
    const style = attrOf(el, "style");
    if (style !== undefined) for (const l of cssLoads(style)) load(l.need, attrLine("style"), l.url);
    const action = tag === "form" ? attrOf(el, "action") : tag === "button" || tag === "input" ? attrOf(el, "formaction") : undefined;
    if (action !== undefined && action.trim() !== "" && !action.trim().startsWith("#") && !/^javascript:/iu.test(action.trim()))
      refused.push({ kind: "form", line, url: action.trim() });
    if (tag === "meta" && attrOf(el, "http-equiv")?.trim().toLowerCase() === "refresh") refused.push({ kind: "refresh", line });
    if (tag === "base" && attrOf(el, "href") !== undefined) refused.push({ kind: "base", line });
  };
  const walk = (nodes: readonly P.ChildNode[]) => {
    for (const n of nodes) {
      if (!isElement(n)) continue;
      visit(n);
      walk(n.childNodes);
      if ("content" in n) walk(n.content.childNodes);
    }
  };
  walk(parse(source, { sourceCodeLocationInfo: true }).childNodes);
  return { refused: refused.toSorted((a, b) => a.line - b.line), warned };
}
