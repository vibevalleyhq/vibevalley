import * as stylex from "@stylexjs/stylex";
import { toDom } from "hast-util-to-dom";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { createMemo, onCleanup } from "solid-js";
import { type Plugin, unified } from "unified";

import { styleProps } from "#/ui/positioner.ts";
import { fragmentOf, remarkIssueRefs, richen } from "#/ui/richText.ts";

import { pxStyle } from "./style";

const styles = stylex.create({
  root: { minWidth: 0, overflowWrap: "break-word" },
  reading: { maxWidth: "560px" },
  plain: { whiteSpace: "pre-wrap" },
  clamped: (lines: number) => ({ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden" }),
  mention: {
    display: "inline-block",
    paddingInline: "0.3em",
    whiteSpace: "nowrap",
    backgroundColor: { default: "currentColor", "@supports (color: color-mix(in lab, red, red))": "color-mix(in oklab, currentColor 13%, transparent)" },
  },
  link: {
    textDecorationLine: "underline",
    textDecorationColor: { default: "currentColor", "@supports (color: color-mix(in lab, red, red))": "color-mix(in oklab, currentColor 45%, transparent)" },
    WebkitTextDecorationColor: { default: null, "@supports (color: color-mix(in lab, red, red))": "color-mix(in oklab, currentColor 45%, transparent)" },
  },
  rule: {
    marginBlock: "calc(var(--spacing) * 2)",
    height: "1.5px",
    backgroundImage: "repeating-linear-gradient(90deg,currentColor 0 3px,transparent 3px 6px)",
    opacity: 0.4,
  },
});

export { plainText } from "@vibevalley/protocol/rules";

const mentionHref = "#mention";

const codeParts = /(```[\s\S]*?```|`[^`\n]*`)/gu;

const mention = /(^|[^\p{L}\p{N}_@])@(w\d+|管家|主人|所有人)/gu;

const mentionLinks = (s: string) => s.replace(mention, (_, before: string, name: string) => `${before}[@${name}](${mentionHref})`);

/** @names outside code become links to mentionHref, as the group chat reads them (protocol MentionsIn). */
export function withMentions(text: string): string {
  let out = "";
  let at = 0;
  for (const m of text.matchAll(codeParts)) {
    out += mentionLinks(text.slice(at, m.index)) + m[0];
    at = m.index + m[0].length;
  }
  return out + mentionLinks(text.slice(at));
}

// Raw HTML in the text is dropped (remark-rehype's default).
const md = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MdNode types only the mdast fields the plugin reads and writes
  .use(remarkIssueRefs as unknown as Plugin)
  .use(remarkRehype);

/** The tree as DOM: a mention link becomes its tag, a link opens through `open` or a new tab, a rule becomes the dashed line. */
function render(text: string, open: ((url: string) => void) | undefined): Node[] {
  const root = fragmentOf(toDom(md.runSync(md.parse(text)), { fragment: true }));
  // Made safe, its code and diagrams drawn, before the links below are given their pixel look.
  onCleanup(richen(root, { pixel: true }));
  for (const a of [...root.querySelectorAll("a")]) {
    if (a.getAttribute("href") === mentionHref) {
      const tag = document.createElement("span");
      tag.className = stylex.attrs(styles.mention).class ?? "";
      tag.append(...a.childNodes);
      a.replaceWith(tag);
      continue;
    }
    a.className = stylex.attrs(styles.link).class ?? "";
    a.rel = "noreferrer";
    if (!open) a.target = "_blank";
    else
      a.addEventListener("click", (e: MouseEvent) => {
        e.preventDefault();
        open(a.href);
      });
  }
  for (const hr of [...root.querySelectorAll("hr")]) {
    const line = document.createElement("div");
    line.setAttribute("role", "separator");
    line.className = stylex.attrs(styles.rule).class ?? "";
    hr.replaceWith(line);
  }
  return [...root.childNodes];
}

/**
 * GitHub-flavoured, no raw HTML. With `mentions`, @w3, @管家, @主人 and @所有人 outside code are small tags. A link
 * goes to `onOpenLink` when given, else opens in a new tab. `reading`: long text in pxStyle.read at most 40 characters
 * a line; headings stay pixel, code stays mono. `styles` carries the colour.
 */
export function PxMarkdown(props: { text: string; mentions?: boolean; onOpenLink?: (url: string) => void; reading?: boolean; styles?: stylex.StyleXStyles }) {
  const nodes = createMemo(() => render(props.mentions === true ? withMentions(props.text) : props.text, props.onOpenLink));
  return (
    <div
      data-pixel-markdown=""
      data-reading={props.reading === true ? "true" : undefined}
      {...styleProps([styles.root, props.reading === true ? [pxStyle.read, styles.reading] : pxStyle.sm, props.styles])}
    >
      {nodes()}
    </div>
  );
}

/** Plain text to read, as PxMarkdown with `reading` draws it. */
export function PxReadText(props: { text: string; maxLines?: number; styles?: stylex.StyleXStyles }) {
  return (
    <p {...styleProps([pxStyle.read, styles.reading, styles.plain, props.styles, props.maxLines !== undefined && styles.clamped(props.maxLines)])}>
      {props.text}
    </p>
  );
}
