import { Option, Schema } from "effect";
import { type DefaultTreeAdapterTypes as P, parse, parseFragment } from "parse5";

import { list, t } from "@vibevalley/i18n";
import { ArtifactKindValues, artifactPath, type HtmlAnchor } from "@vibevalley/protocol";
import { htmlSandbox, isOneOf } from "@vibevalley/protocol/rules";
import { HtmlShellMessage } from "@vibevalley/protocol/schema";

/** The largest artifact body, bytes, and title, characters. */
export const artifactMax = 5 * 1024 * 1024;
const artifactTitleMax = 80;

/** Why a title, a kind or a hand-in's size is refused, in the owner's words. "" when they are right. */
export function artifactProblem(a: { readonly title?: string; readonly kind?: string; readonly size?: number }): string {
  if (a.title !== undefined) {
    const n = [...a.title.trim()].length;
    if (n === 0) return t("server.artifact.noTitle");
    if (n > artifactTitleMax) return t("server.artifact.longTitle", { max: artifactTitleMax });
  }
  if (a.kind !== undefined && !isOneOf(ArtifactKindValues, a.kind)) return t("server.artifact.badKind", { kind: a.kind, kinds: ArtifactKindValues.join(", ") });
  if (a.size === undefined) return "";
  if (a.size === 0) return t("server.artifact.empty");
  if (a.size > artifactMax) return t("server.artifact.tooBig", { mb: artifactMax / 1024 / 1024 });
  return "";
}

const libraries = ["https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"];

/** Where an HTML artifact may load from besides its own inline code. */
export const htmlSources = {
  script: libraries,
  style: [...libraries, "https://fonts.googleapis.com"],
  font: [...libraries, "https://fonts.gstatic.com"],
} as const;

/** An HTML artifact is someone else's page: it must never run as one of the farm's. */
export const htmlPolicy = [
  `sandbox ${htmlSandbox}`,
  "default-src 'none'",
  ["script-src 'unsafe-inline'", ...htmlSources.script].join(" "),
  ["style-src 'unsafe-inline'", ...htmlSources.style].join(" "),
  "img-src data: blob:",
  ["font-src data:", ...htmlSources.font].join(" "),
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** An html artifact's version never changes once made: cached for good. A blocks one is not served as a file. */
export const artifactHeaders: Record<string, string> = {
  "cache-control": "private, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": htmlPolicy,
};

export const demoPieces = 6;
export const demoJitter = 0.3;

const shellScript = String.raw`(() => {
  const hidden = new Set(["HEAD", "SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "TEXTAREA", "TITLE"]);
  const context = 32;
  const texts = () => {
    const out = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        for (let p = n.parentElement; p; p = p.parentElement) if (hidden.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  };
  const indexOf = (nodes, container, offset) => {
    const point = document.createRange();
    point.setStart(container, offset);
    let at = 0;
    for (const t of nodes) {
      if (t === container) return at + offset;
      if (point.comparePoint(t, 0) >= 0) return at;
      at += t.data.length;
    }
    return at;
  };
  const anchor = () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const nodes = texts();
    const whole = nodes.map((t) => t.data).join("");
    const from = indexOf(nodes, range.startContainer, range.startOffset);
    const to = indexOf(nodes, range.endContainer, range.endOffset);
    const exact = whole.slice(from, to);
    if (exact.trim() === "") return null;
    return { kind: "text", exact, prefix: whole.slice(Math.max(0, from - context), from), suffix: whole.slice(to, to + context) };
  };
  let timer = 0;
  document.addEventListener("selectionchange", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      let found = null;
      try {
        found = anchor();
      } catch {
        found = null;
      }
      if (found) parent.postMessage({ vibevalley: "selection", anchor: found }, "*");
    }, 150);
  });
})();`;

/** The page as the workbench shows it: the shell after everything else, so it runs once the page's own text is there. */
export const withShell = (page: string) => `${page}\n<script>${shellScript}</script>\n`;

export const shellPath = (id: string, version: number) => `${artifactPath(id, version)}?shell=1`;

const decodeShellMessage = Schema.decodeUnknownOption(HtmlShellMessage);
const wordsMax = 10_000;
const contextMax = 64;

/** The words the owner selected, as the message tells of them; undefined when it is no such message. */
export function selectionOf(data: unknown): HtmlAnchor | undefined {
  const anchor = Option.getOrUndefined(decodeShellMessage(data))?.anchor;
  if (!anchor) return undefined;
  return anchor.exact.length > wordsMax || anchor.prefix.length > contextMax || anchor.suffix.length > contextMax ? undefined : anchor;
}

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
  } catch {
    return false;
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

const shownMax = 8;

/** Why a page is refused, in the owner's words; "" when it may be kept. */
export function htmlProblem(check: HtmlCheck): string {
  if (check.refused.length === 0) return "";
  const shown = check.refused.slice(0, shownMax).map((f) => "\n- " + refusalText(f));
  const more = check.refused.length > shownMax ? "\n" + t("server.artifact.check.more", { n: check.refused.length - shownMax }) : "";
  return t("server.artifact.check.refused", { n: check.refused.length }) + shown.join("") + more;
}
