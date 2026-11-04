import { type DefaultTreeAdapterTypes as P, parse, parseFragment } from "parse5";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

/** One character of the page's text: the text node it is in and the source bytes it was written as (an entity is several
 * bytes for one character). node is -1 for a run of whitespace that spans nodes. */
interface At {
  readonly node: number;
  readonly from: number;
  readonly to: number;
}

/** Text the owner does not select as the page's words: code, and what a script or the browser draws instead. */
const hidden = new Set(["head", "script", "style", "template", "noscript", "textarea", "title"]);
const reference = /^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);?/iu;
const space = /\s/u;
const squash = (s: string) => s.replace(/\s+/gu, " ");
const bare = (s: string) => s.replace(/\s+/gu, "");

/** A stray & with letters after it reads as itself. */
function decoded(ref: string): string {
  const n = parseFragment(ref).childNodes[0];
  return n && "value" in n && n.nodeName === "#text" ? n.value : ref;
}

/** The page's text as the shell reads it, whitespace runs as one space, each character with where it was written. */
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
        // By UTF-16 unit, as indexOf counts: one entry for each unit of the text.
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

export function htmlEdit(source: string, anchor: T.HtmlAnchor, text: string): HtmlEdited {
  const refused = (why: string): HtmlEdited => ({ ok: false, why });
  const exact = squash(anchor.exact).trim();
  if (exact === "") return refused(t("server.artifact.edit.empty"));
  if (squash(text).trim() === exact) return refused(t("server.artifact.edit.same"));
  const page = pageText(source);
  const found: number[] = [];
  for (let k = page.text.indexOf(exact); k >= 0; k = page.text.indexOf(exact, k + 1)) found.push(k);
  if (found.length === 0) return refused(t("server.artifact.edit.notFound", { words: exact }));
  // Compared without whitespace: the shell and the source may break the words around them differently.
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
