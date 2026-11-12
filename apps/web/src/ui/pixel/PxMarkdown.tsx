import type { JSX } from "@solidjs/web";
import type * as stylex from "@stylexjs/stylex";
import { toDom } from "hast-util-to-dom";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { createMemo, onCleanup } from "solid-js";
import { type Plugin, unified } from "unified";

import { withStyles } from "#/ui/positioner.ts";
import { fragmentOf, remarkIssueRefs, richen } from "#/ui/richText.ts";

const mentionClass = "inline-block px-[0.3em] whitespace-nowrap bg-current/13";
const linkClass = "underline decoration-current/45";
const ruleClass = "my-2 h-[1.5px] bg-[repeating-linear-gradient(90deg,currentColor_0_3px,transparent_3px_6px)] opacity-40";

export { plainText } from "@vibevalley/protocol/rules";

const mentionHref = "#mention";

const codeParts = /(```[\s\S]*?```|`[^`\n]*`)/gu;

const mention = /(^|[^\p{L}\p{N}_@])@(w\d+|助手|用户|所有人)/gu;

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
      tag.className = mentionClass;
      tag.append(...a.childNodes);
      a.replaceWith(tag);
      continue;
    }
    a.className = linkClass;
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
    line.className = ruleClass;
    hr.replaceWith(line);
  }
  return [...root.childNodes];
}

/**
 * GitHub-flavoured, no raw HTML. `mentions`: @w3, @助手, @用户 and @所有人 outside code become tags.
 * Links use `onOpenLink` when given, otherwise a new tab. `reading` limits lines to 40ch.
 */
export function PxMarkdown(props: {
  text: string;
  mentions?: boolean;
  onOpenLink?: (url: string) => void;
  reading?: boolean;
  class?: JSX.ClassValue | undefined;
  // For callers still on StyleX; it goes when the last of them is on classes.
  styles?: stylex.StyleXStyles;
}) {
  const nodes = createMemo(() => render(props.mentions === true ? withMentions(props.text) : props.text, props.onOpenLink));
  return (
    <div
      data-pixel-markdown=""
      data-reading={props.reading === true ? "true" : undefined}
      {...withStyles(props.styles, ["min-w-0 wrap-break-word", props.reading === true ? "max-w-[560px] pixel-read" : "pixel-sm", props.class])}
    >
      {nodes()}
    </div>
  );
}

/** Plain text to read, as PxMarkdown with `reading` draws it. */
export function PxReadText(props: {
  text: string;
  maxLines?: number;
  class?: JSX.ClassValue | undefined;
  // For callers still on StyleX; it goes when the last of them is on classes.
  styles?: stylex.StyleXStyles;
}) {
  return (
    <p
      {...withStyles(
        props.styles,
        // Important, so the clamp holds over a caller's styles as it did.
        ["max-w-[560px] whitespace-pre-wrap pixel-read", props.class, props.maxLines !== undefined && "line-clamp-(--lines)!"],
        props.maxLines === undefined ? undefined : { "--lines": String(props.maxLines) },
      )}
    >
      {props.text}
    </p>
  );
}
