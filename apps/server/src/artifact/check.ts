import { type DefaultTreeAdapterTypes as P, parse } from "parse5";

import { list, t } from "@vibevalley/i18n";

import { htmlSources } from "./policy.ts";

/** What a URL in the page is for, so which list it must be on: inline is pictures and media, data: or blob: only. */
type Need = "script" | "style" | "font" | "inline" | "link";

export type HtmlRefusal =
  | { readonly kind: "load"; readonly need: Need; readonly line: number; readonly url: string }
  | { readonly kind: "form"; readonly line: number; readonly url: string }
  | { readonly kind: "refresh"; readonly line: number }
  | { readonly kind: "base"; readonly line: number }
  | { readonly kind: "frame"; readonly line: number; readonly tag: string };

/** A script's call to the network: the CSP stops it, the helper hears that part of its page will not work. */
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
  } catch {
    // Relative: it would load from the farm's own server, which the CSP never lets the page reach.
    return false;
  }
}

/** What puts another page inside this one. */
const frames = new Set(["iframe", "frame", "frameset", "object", "embed", "portal", "fencedframe"]);
/** An attribute not listed here is not judged; the CSP still stands. */
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

/** A srcset's URLs. Not split on every comma: a data: URL has one. */
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

/** The same length with only its line breaks: a span blanked keeps every line after it where it was. */
const blank = (s: string) => s.replace(/[^\n]/gu, " ");
const lineAt = (text: string, at: number) => text.slice(0, at).split("\n").length - 1;

/** CSS's loads: an @import is a stylesheet, a url() in an @font-face a font, any other url() a picture. */
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

const hostList = (need: Need) => list(hosts[need].map((h) => new URL(h).host));

const loadText: Record<Need, (line: number, url: string) => string> = {
  script: (line, url) => t("server.artifact.check.script", { line, url, hosts: hostList("script") }),
  style: (line, url) => t("server.artifact.check.style", { line, url, hosts: hostList("style") }),
  font: (line, url) => t("server.artifact.check.font", { line, url, hosts: hostList("font") }),
  inline: (line, url) => t("server.artifact.check.inline", { line, url }),
  link: (line, url) => t("server.artifact.check.link", { line, url, hosts: hostList("link") }),
};

function refusalText(f: HtmlRefusal): string {
  switch (f.kind) {
    case "load":
      return loadText[f.need](f.line, f.url);
    case "form":
      return t("server.artifact.check.form", { line: f.line, url: f.url });
    case "refresh":
      return t("server.artifact.check.refresh", { line: f.line });
    case "base":
      return t("server.artifact.check.base", { line: f.line });
    case "frame":
      return t("server.artifact.check.frame", { line: f.line, tag: f.tag });
  }
}

/** How many refusals one answer lists; the helper fixes those and hands in again to hear about the rest. */
const shownMax = 8;

/** Why a page is refused, in the owner's words; "" when it may be kept. */
export function htmlProblem(check: HtmlCheck): string {
  if (check.refused.length === 0) return "";
  const shown = check.refused.slice(0, shownMax).map((f) => "\n- " + refusalText(f));
  const more = check.refused.length > shownMax ? "\n" + t("server.artifact.check.more", { n: check.refused.length - shownMax }) : "";
  return t("server.artifact.check.refused", { n: check.refused.length }) + shown.join("") + more;
}
