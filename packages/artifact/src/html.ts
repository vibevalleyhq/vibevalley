import { type DefaultTreeAdapterTypes as P, parse, parseFragment } from "parse5";
import { z } from "zod";

import { list, t } from "@vibevalley/i18n";
import { type ArtifactBody, type ArtifactDisplay, type ArtifactHtmlEdit, ArtifactKindValues, type HtmlAnchor } from "@vibevalley/protocol";
import { htmlSandbox, isOneOf } from "@vibevalley/protocol/rules";

type ArtifactKind = (typeof ArtifactKindValues)[number];

/** The largest artifact body, bytes, and title, characters. */
export const artifactMax = 5 * 1024 * 1024;
export const artifactPrefix = "/api/v1/artifact/";
const artifactTitleMax = 80;

/** Why a title, a kind or a hand-in's size is refused, in the user's words. "" when they are right. */
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
const htmlLimits = [
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
export const htmlPolicy = `sandbox ${htmlSandbox}; ${htmlLimits}`;

/** The same page opened on its own to be printed (a deck saved as a PDF): it may open the print dialog, nothing more. */
const htmlPrintPolicy = `sandbox ${htmlSandbox} allow-modals; ${htmlLimits}`;

/** An html artifact's version never changes once made: cached for good. A blocks one is not served as a file. */
export const artifactHeaders: Record<string, string> = {
  "cache-control": "private, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": htmlPolicy,
};

export const artifactPrintHeaders: Record<string, string> = { ...artifactHeaders, "content-security-policy": htmlPrintPolicy };

export const demoPieces = 6;
export const demoJitter = 0.3;

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

const escAttr = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

type HtmlCanvasPatch = NonNullable<ArtifactHtmlEdit["canvas"]>;
type HtmlLayerPatch = HtmlCanvasPatch["layers"][number];

const formatNumber = (n: number, decimals: number): string => {
  const factor = 10 ** decimals;
  const rounded = Math.round(n * factor) / factor;
  return String(rounded === 0 ? 0 : rounded);
};

interface TextSpanNode {
  readonly startOffset: number;
  readonly endOffset: number;
}

function collectVisibleTextSpans(nodes: readonly P.ChildNode[], out: TextSpanNode[]) {
  for (const n of nodes) {
    if ("tagName" in n) {
      const tag = n.tagName.toLowerCase();
      if (!hidden.has(tag) && tag !== "vv-assets" && tag !== "defs") collectVisibleTextSpans(n.childNodes, out);
      continue;
    }
    const loc = n.sourceCodeLocation;
    if (n.nodeName === "#text" && loc && n.value.trim() !== "") out.push({ startOffset: loc.startOffset, endOffset: loc.endOffset });
  }
}

function findFirstBoard(nodes: readonly P.ChildNode[]): P.Element | undefined {
  for (const n of nodes) {
    if (!isElement(n)) continue;
    if (n.tagName.toLowerCase() === "vv-board") return n;
    const inner = findFirstBoard(n.childNodes);
    if (inner) return inner;
  }
  return undefined;
}

function mapCanvasTargets(nodes: readonly P.ChildNode[], out: Map<string, P.Element>) {
  for (const n of nodes) {
    if (!isElement(n)) continue;
    const tag = n.tagName.toLowerCase();
    if (tag === "vv-assets") continue;
    if (tag === "vv-layer" || tag === "vv-group") {
      const id = attrOf(n, "id")?.trim() ?? "";
      if (id !== "" && !out.has(id)) out.set(id, n);
    }
    mapCanvasTargets(n.childNodes, out);
  }
}

export function canvasEdit(source: string, patch: HtmlCanvasPatch): HtmlEdited {
  const refused = (why: string): HtmlEdited => ({ ok: false, why });
  const doc = parse(source, { sourceCodeLocationInfo: true });
  const board = findFirstBoard(doc.childNodes);
  if (!board) return refused(t("server.artifact.edit.canvasNotFound"));

  const targets = new Map<string, P.Element>();
  mapCanvasTargets(board.childNodes, targets);

  const mergedLayers = new Map<string, HtmlLayerPatch>();
  for (const lp of patch.layers) {
    if (!targets.has(lp.id)) return refused(t("server.artifact.edit.canvasNotFound"));
    const prev = mergedLayers.get(lp.id);
    mergedLayers.set(lp.id, prev ? { ...prev, ...lp } : lp);
  }

  const edits: { readonly start: number; readonly end: number; readonly text: string }[] = [];
  const editStartTag = (el: P.Element, updates: Readonly<Record<string, string | boolean | undefined>>): boolean => {
    const loc = el.sourceCodeLocation;
    const startTag = loc?.startTag;
    if (!startTag) return false;
    const attrs = new Map<string, { value: string; bare: boolean }>();
    for (const a of el.attrs) {
      const rawLoc = loc.attrs?.[a.name];
      const bare = rawLoc ? !source.slice(rawLoc.startOffset, rawLoc.endOffset).includes("=") : false;
      attrs.set(a.name, { value: a.value, bare });
    }
    for (const [k, v] of Object.entries(updates)) {
      if (v === undefined) continue;
      if (v === false) attrs.delete(k);
      else if (v === true) attrs.set(k, { value: "", bare: true });
      else attrs.set(k, { value: v, bare: false });
    }
    const rawTag = source.slice(startTag.startOffset, startTag.endOffset);
    const selfClosing = /\/\s*>$/u.test(rawTag);
    const parts = [...attrs.entries()].map(([k, entry]) => (entry.bare ? ` ${k}` : ` ${k}="${escAttr(entry.value)}"`));
    edits.push({ start: startTag.startOffset, end: startTag.endOffset, text: `<${el.tagName}${parts.join("")}${selfClosing ? " /" : ""}>` });
    return true;
  };

  if (patch.board !== undefined) {
    const updates: Record<string, string | boolean | undefined> = {};
    if (patch.board.palette !== undefined) updates.palette = patch.board.palette;
    if (patch.board.grain !== undefined) updates.grain = formatNumber(patch.board.grain, 3);
    if (Object.keys(updates).length > 0 && !editStartTag(board, updates)) return refused(t("server.artifact.edit.canvasNotFound"));
  }

  for (const [id, lp] of mergedLayers) {
    const el = targets.get(id);
    if (!el) return refused(t("server.artifact.edit.canvasNotFound"));
    const updates: Record<string, string | boolean | undefined> = {};
    if (lp.x !== undefined) updates.x = formatNumber(lp.x, 2);
    if (lp.y !== undefined) updates.y = formatNumber(lp.y, 2);
    if (lp.w !== undefined) updates.w = formatNumber(lp.w, 2);
    if (lp.h !== undefined) updates.h = formatNumber(lp.h, 2);
    if (lp.rotate !== undefined) updates.rotate = formatNumber(lp.rotate, 2);
    if (lp.z !== undefined) updates.z = formatNumber(lp.z, 2);
    if (lp.opacity !== undefined) updates.opacity = formatNumber(lp.opacity, 3);
    if (lp.flip !== undefined) updates.flip = lp.flip === "none" ? false : lp.flip;
    if (lp.filter !== undefined) updates.filter = lp.filter === "none" ? false : lp.filter;
    if (lp.locked !== undefined) updates.locked = lp.locked;
    if (lp.hidden !== undefined) updates.hidden = lp.hidden;
    if (Object.keys(updates).length > 0 && !editStartTag(el, updates)) return refused(t("server.artifact.edit.canvasNotFound"));

    if (lp.text !== undefined && el.tagName.toLowerCase() !== "vv-group") {
      const spans: TextSpanNode[] = [];
      collectVisibleTextSpans(el.childNodes, spans);
      if (spans.length === 1 && spans[0]) {
        edits.push({ start: spans[0].startOffset, end: spans[0].endOffset, text: escaped(lp.text) });
      } else if (spans.length > 1) {
        const lines = lp.text.split("\n");
        for (let sIdx = spans.length - 1; sIdx >= 0; sIdx -= 1) {
          const sp = spans[sIdx];
          if (sp) edits.push({ start: sp.startOffset, end: sp.endOffset, text: escaped(lines[sIdx] ?? "") });
        }
      } else if (!el.childNodes.some(isElement)) {
        const loc = el.sourceCodeLocation;
        if (loc?.startTag && loc.endTag) edits.push({ start: loc.startTag.endOffset, end: loc.endTag.startOffset, text: escaped(lp.text) });
      }
    }
  }

  let out = source;
  for (const e of edits.toSorted((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return { ok: true, source: out };
}

type Need = "script" | "style" | "font" | "inline" | "link";

export type HtmlRefusal =
  | { readonly kind: "load"; readonly need: Need; readonly line: number; readonly url: string }
  | { readonly kind: "form"; readonly line: number; readonly url: string }
  | { readonly kind: "refresh"; readonly line: number }
  | { readonly kind: "base"; readonly line: number }
  | { readonly kind: "frame"; readonly line: number; readonly tag: string }
  | { readonly kind: "canvasBoardAttr"; readonly line: number }
  | { readonly kind: "canvasLayerId"; readonly line: number; readonly id: string }
  | { readonly kind: "canvasLayerBox"; readonly line: number; readonly id: string }
  | { readonly kind: "canvasAssetMissing"; readonly line: number; readonly id: string; readonly asset: string }
  | { readonly kind: "canvasInlineData"; readonly line: number };

export interface HtmlWarning {
  readonly line: number;
  readonly call: string;
  readonly message?: string;
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

const canvasInlineDataLimit = 2048;
const canvasOcclusionLimit = 8;
const figureTags = new Set(["img", "svg"]);

function parseNum(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function parsePositive(v: string | undefined): number | undefined {
  const n = parseNum(v);
  return n !== undefined && n > 0 ? n : undefined;
}

function hasVisibleText(el: P.Element): boolean {
  for (const n of el.childNodes) {
    if (isElement(n)) {
      const tag = n.tagName.toLowerCase();
      if (!hidden.has(tag) && tag !== "vv-assets" && tag !== "defs" && hasVisibleText(n)) return true;
      continue;
    }
    if (n.nodeName === "#text" && "value" in n && n.value.trim() !== "") return true;
  }
  return false;
}

function hasSubtreeTag(el: P.Element, tags: ReadonlySet<string>): boolean {
  for (const n of el.childNodes) {
    if (!isElement(n)) continue;
    const tag = n.tagName.toLowerCase();
    if (tag === "vv-assets" || tag === "template") continue;
    if (tags.has(tag) || hasSubtreeTag(n, tags)) return true;
  }
  return false;
}

function collectAssetIds(nodes: readonly P.ChildNode[], inAssets: boolean, out: Set<string>) {
  for (const n of nodes) {
    if (!isElement(n)) continue;
    const tag = n.tagName.toLowerCase();
    const inside = inAssets || tag === "vv-assets";
    if (inside) {
      const id = attrOf(n, "id")?.trim();
      if (id) out.add(id);
    }
    collectAssetIds(n.childNodes, inside, out);
  }
}

function collectBoards(nodes: readonly P.ChildNode[], out: P.Element[]) {
  for (const n of nodes) {
    if (!isElement(n)) continue;
    if (n.tagName.toLowerCase() === "vv-board") out.push(n);
    else collectBoards(n.childNodes, out);
  }
}

interface CheckedCanvasLayer {
  readonly id: string;
  readonly line: number;
  readonly ax: number;
  readonly ay: number;
  readonly w: number;
  readonly h: number;
  readonly isBleedOrBg: boolean;
  readonly isFigure: boolean;
  readonly isText: boolean;
}

function checkInlineCanvasData(el: P.Element, attrLine: (name: string) => number, refused: HtmlRefusal[]) {
  for (const name of ["src", "href", "poster"] as const) {
    const v = attrOf(el, name);
    if (v !== undefined && /^data:/iu.test(v.trim()) && v.trim().length > canvasInlineDataLimit) {
      refused.push({ kind: "canvasInlineData", line: attrLine(name) });
      return;
    }
  }
  const srcset = attrOf(el, "srcset");
  if (srcset !== undefined) {
    for (const u of srcsetUrls(srcset)) {
      if (/^data:/iu.test(u.trim()) && u.trim().length > canvasInlineDataLimit) {
        refused.push({ kind: "canvasInlineData", line: attrLine("srcset") });
        return;
      }
    }
  }
  const style = attrOf(el, "style");
  if (style !== undefined) {
    for (const l of cssLoads(style)) {
      if (/^data:/iu.test(l.url.trim()) && l.url.trim().length > canvasInlineDataLimit) {
        refused.push({ kind: "canvasInlineData", line: attrLine("style") });
        return;
      }
    }
  }
}

function canvasCheck(rootNodes: readonly P.ChildNode[], refused: HtmlRefusal[], warned: HtmlWarning[]) {
  const boards: P.Element[] = [];
  collectBoards(rootNodes, boards);
  if (boards.length === 0) return;

  const assetIds = new Set<string>();
  collectAssetIds(rootNodes, false, assetIds);

  for (const board of boards) {
    const boardLine = board.sourceCodeLocation?.startLine ?? 1;
    const boardW = parsePositive(attrOf(board, "width"));
    const boardH = parsePositive(attrOf(board, "height"));
    if (boardW === undefined || boardH === undefined) refused.push({ kind: "canvasBoardAttr", line: boardLine });

    const seenIds = new Set<string>();
    const layers: CheckedCanvasLayer[] = [];

    const walkBoard = (nodes: readonly P.ChildNode[], offsetX: number, offsetY: number, parentHidden: boolean) => {
      for (const n of nodes) {
        if (!isElement(n)) continue;
        const tag = n.tagName.toLowerCase();
        if (tag === "vv-assets") continue;

        const at = n.sourceCodeLocation;
        const line = at?.startLine ?? 1;
        const attrLine = (name: string) => at?.attrs?.[name]?.startLine ?? line;
        checkInlineCanvasData(n, attrLine, refused);

        if (tag === "vv-group") {
          const gid = attrOf(n, "id")?.trim() ?? "";
          if (gid !== "") {
            if (seenIds.has(gid)) refused.push({ kind: "canvasLayerId", line, id: gid });
            else seenIds.add(gid);
          }
          const gx = parseNum(attrOf(n, "x")) ?? 0;
          const gy = parseNum(attrOf(n, "y")) ?? 0;
          const groupHidden = parentHidden || attrOf(n, "hidden") !== undefined;
          walkBoard(n.childNodes, offsetX + gx, offsetY + gy, groupHidden);
          continue;
        }

        if (tag === "vv-layer") {
          const id = attrOf(n, "id")?.trim() ?? "";
          if (id === "" || seenIds.has(id)) refused.push({ kind: "canvasLayerId", line, id });
          if (id !== "") seenIds.add(id);

          const x = parseNum(attrOf(n, "x"));
          const y = parseNum(attrOf(n, "y"));
          const w = parsePositive(attrOf(n, "w"));
          const h = parsePositive(attrOf(n, "h"));
          const validBox = x !== undefined && y !== undefined && w !== undefined && h !== undefined;
          if (!validBox) refused.push({ kind: "canvasLayerBox", line, id });

          const assetAttr = attrOf(n, "asset");
          if (assetAttr !== undefined) {
            const asset = assetAttr.trim();
            if (asset === "" || !assetIds.has(asset)) refused.push({ kind: "canvasAssetMissing", line, id, asset });
          }

          const isHidden = parentHidden || attrOf(n, "hidden") !== undefined;
          if (validBox && !isHidden) {
            const ax = offsetX + x;
            const ay = offsetY + y;
            const hasBleed = attrOf(n, "bleed") !== undefined;
            if (!hasBleed && boardW !== undefined && boardH !== undefined && (ax < 0 || ay < 0 || ax + w > boardW || ay + h > boardH)) {
              warned.push({
                line,
                call: "canvas-bounds",
                message: t("server.artifact.check.canvasOutOfBounds", {
                  line,
                  id,
                  box: `${ax},${ay} ${w}x${h}`,
                  board: `${boardW}x${boardH}`,
                }),
              });
            }
            const isBleedOrBg = hasBleed || attrOf(n, "allow-overlap") !== undefined || (parseNum(attrOf(n, "z")) ?? 0) < 0;
            const isFigure = assetAttr !== undefined || hasSubtreeTag(n, figureTags);
            const isText = hasVisibleText(n);
            layers.push({ id, line, ax, ay, w, h, isBleedOrBg, isFigure, isText });
          }
        }

        walkBoard(n.childNodes, offsetX, offsetY, parentHidden);
      }
    };

    walkBoard(board.childNodes, 0, 0, false);

    for (let i = 0; i < layers.length; i++) {
      const a = layers[i];
      if (!a || a.isBleedOrBg) continue;
      for (let j = i + 1; j < layers.length; j++) {
        const b = layers[j];
        if (!b || b.isBleedOrBg) continue;
        const ix = Math.max(0, Math.min(a.ax + a.w, b.ax + b.w) - Math.max(a.ax, b.ax));
        const iy = Math.max(0, Math.min(a.ay + a.h, b.ay + b.h) - Math.max(a.ay, b.ay));
        const textOverlap = (a.isText && b.isText) || (a.isFigure && b.isText) || (a.isText && b.isFigure);
        if (ix > canvasOcclusionLimit && iy > canvasOcclusionLimit && textOverlap) {
          warned.push({
            line: b.line,
            call: "canvas-occlusion",
            message: t("server.artifact.check.canvasOcclusion", {
              line: b.line,
              id: b.id,
              other: a.id,
              overlap: Math.round(Math.min(ix, iy)),
            }),
          });
        }
      }
    }
  }
}

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
  const doc = parse(source, { sourceCodeLocationInfo: true });
  walk(doc.childNodes);
  canvasCheck(doc.childNodes, refused, warned);
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
    case "canvasBoardAttr":
      return t("server.artifact.check.canvasBoardAttr", { line: f.line });
    case "canvasLayerId":
      return t("server.artifact.check.canvasLayerId", { line: f.line, id: f.id });
    case "canvasLayerBox":
      return t("server.artifact.check.canvasLayerBox", { line: f.line, id: f.id });
    case "canvasAssetMissing":
      return t("server.artifact.check.canvasAssetMissing", { line: f.line, id: f.id, asset: f.asset });
    case "canvasInlineData":
      return t("server.artifact.check.canvasInlineData", { line: f.line });
  }
}

const shownMax = 8;

/** Why a page is refused, in the user's words; "" when it may be kept. */
export function htmlProblem(check: HtmlCheck): string {
  if (check.refused.length === 0) return "";
  const shown = check.refused.slice(0, shownMax).map((f) => "\n- " + refusalText(f));
  const more = check.refused.length > shownMax ? "\n" + t("server.artifact.check.more", { n: check.refused.length - shownMax }) : "";
  return t("server.artifact.check.refused", { n: check.refused.length }) + shown.join("") + more;
}

const escHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function artifactSuffixOf(a: { readonly body: ArtifactBody; readonly display?: ArtifactDisplay | undefined }): string {
  if (a.body === "blocks") return ".doc.md";
  switch (a.display ?? "page") {
    case "canvas":
      return ".visual.html";
    case "slides":
      return ".slide.html";
    case "dashboard":
      return ".dashboard.html";
    case "motion":
      return ".motion.html";
    case "whiteboard":
      return ".whiteboard";
    case "page":
      return ".html";
  }
}

export function inferDisplayFromContent(content: string | undefined): ArtifactDisplay | undefined {
  if (content === undefined || content.trim() === "") return undefined;
  if (
    /<vv-board[^>]*\bdata-mode=["']whiteboard["']/iu.test(content) ||
    /<vv-edge\b/iu.test(content) ||
    (/^\s*\{/u.test(content) && /"nodes"\s*:/u.test(content))
  )
    return "whiteboard";
  if (/<vv-board[^>]*\bdata-mode=["']dashboard["']/iu.test(content) || /<vv-dashboard\b/iu.test(content)) return "dashboard";
  if (/<vv-board\b/iu.test(content)) return "canvas";
  return undefined;
}

export function inferArtifactFromName(
  name: string,
  content?: string,
): { readonly title: string; readonly kind: ArtifactKind; readonly display?: ArtifactDisplay } {
  const trimmed = name.trim();
  const rules: readonly { readonly re: RegExp; readonly kind: ArtifactKind; readonly display?: ArtifactDisplay | "infer" }[] = [
    { re: /^(.+?)\.(?:slide|slides)\.html$/iu, kind: "html", display: "slides" },
    { re: /^(.+?)\.(?:visual|canvas)\.html$/iu, kind: "html", display: "canvas" },
    { re: /^(.+?)\.dashboard\.html$/iu, kind: "html", display: "dashboard" },
    { re: /^(.+?)\.motion\.html$/iu, kind: "html", display: "motion" },
    { re: /^(.+?)\.whiteboard(?:\.json|\.html)?$/iu, kind: "html", display: "whiteboard" },
    { re: /^(.+?)\.(?:page\.html|html|htm)$/iu, kind: "html", display: "infer" },
    { re: /^(.+?)\.(?:doc\.md|md|markdown)$/iu, kind: "markdown" },
  ];
  for (const r of rules) {
    const m = r.re.exec(trimmed);
    if (!m) continue;
    const title = m[1]?.trim() || trimmed;
    if (r.kind === "markdown") return { title, kind: "markdown" };
    const display = r.display === "infer" ? (inferDisplayFromContent(content) ?? "page") : r.display;
    return { title, kind: "html", ...(display !== undefined ? { display } : {}) };
  }
  const byContent = inferDisplayFromContent(content);
  if (byContent !== undefined) return { title: trimmed, kind: "html", display: byContent };
  if (content !== undefined && /^\s*(?:<!doctype\s+html|<html\b|<vv-board\b|<section\b)/iu.test(content)) {
    return { title: trimmed, kind: "html", display: "page" };
  }
  return { title: trimmed, kind: "markdown" };
}

const WhiteboardNodeSchema = z.object({
  id: z.string().min(1),
  name: z.optional(z.string()),
  label: z.string(),
  text: z.optional(z.string()),
  x: z.number(),
  y: z.number(),
  w: z.optional(z.number()),
  h: z.optional(z.number()),
  kind: z.optional(z.enum(["rect", "note", "pill", "group"])),
  tone: z.optional(z.enum(["ink", "leaf", "water", "wheat", "berry", "accent"])),
});

const WhiteboardEdgeSchema = z.object({
  id: z.optional(z.string()),
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.optional(z.string()),
  style: z.optional(z.enum(["solid", "dashed"])),
});

const WhiteboardDocSchema = z.object({
  width: z.optional(z.number()),
  height: z.optional(z.number()),
  palette: z.optional(z.enum(["workbench", "brutalist-red", "newsprint", "blueprint"])),
  nodes: z.array(WhiteboardNodeSchema).min(1),
  edges: z.optional(z.array(WhiteboardEdgeSchema)),
});

export function normalizeWhiteboardContent(content: string, title = "Whiteboard"): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return content;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return content;
  }
  const parsed = WhiteboardDocSchema.safeParse(raw);
  if (!parsed.success) return content;
  const doc = parsed.data;
  const width = Math.max(400, Math.round(doc.width ?? 1600));
  const height = Math.max(300, Math.round(doc.height ?? 1000));
  const palette = doc.palette ?? "workbench";
  const nodeLines = doc.nodes.map((node) => {
    const kind = node.kind ?? "rect";
    const w = Math.max(60, Math.round(node.w ?? 240));
    const h = Math.max(40, Math.round(node.h ?? (kind === "pill" ? 64 : 112)));
    const x = Math.round(node.x);
    const y = Math.round(node.y);
    const zIndex = kind === "group" ? 1 : 4;
    const nodeName = (node.name ?? node.label).trim() || node.id;
    const toneAttr = node.tone ? ` data-tone="${escAttr(node.tone)}"` : "";
    const titleEl = `<div class="vv-wb-title">${escHtml(node.label)}</div>`;
    const bodyEl = node.text !== undefined && node.text !== "" ? `<div class="vv-wb-body">${escHtml(node.text)}</div>` : "";
    return `  <vv-layer id="${escAttr(node.id)}" name="${escAttr(nodeName)}" x="${x}" y="${y}" w="${w}" h="${h}" z="${zIndex}" data-node-kind="${kind}"${toneAttr}><div class="vv-wb-node">${titleEl}${bodyEl}</div></vv-layer>`;
  });
  const edgeLines = (doc.edges ?? []).map((edge, idx) => {
    const idAttr = edge.id ? ` id="${escAttr(edge.id)}"` : ` id="edge-${idx + 1}"`;
    const labelAttr = edge.label !== undefined && edge.label !== "" ? ` label="${escAttr(edge.label)}"` : "";
    const styleAttr = edge.style ? ` data-style="${edge.style}"` : "";
    return `  <vv-edge${idAttr} from="${escAttr(edge.from)}" to="${escAttr(edge.to)}"${labelAttr}${styleAttr}></vv-edge>`;
  });
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '  <meta charset="utf-8">',
    `  <title>${escHtml(title)}</title>`,
    "</head>",
    "<body>",
    `<vv-board data-mode="whiteboard" width="${width}" height="${height}" palette="${palette}">`,
    ...edgeLines,
    ...nodeLines,
    "</vv-board>",
    "</body>",
    "</html>",
  ].join("\n");
}
