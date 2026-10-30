import { createMemo, onCleanup } from "solid-js";
import { toDom } from "hast-util-to-dom";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type Plugin, unified } from "unified";
import { fragmentOf, richen } from "@/ui/richText";
import { remarkIssueRefs } from "@/ui/richRules";
import { mentionHref, withMentions } from "./markdown";
import { cx, pxText } from "./style";

// Colours follow the text around it (currentColor), so the same rules read on cream paper and on a green bubble.
// One weight and no italics: ** and * show as plain words.
const common =
  "min-w-0 break-words [&_strong]:font-normal [&_em]:not-italic [&_del]:line-through [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_blockquote]:border-l-2 [&_blockquote]:border-current/30 [&_blockquote]:pl-3 [&_blockquote]:opacity-80 [&_code]:bg-current/10 [&_code]:px-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:bg-current/10 [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-2 [&_td]:border [&_td]:border-current/25 [&_td]:px-2 [&_th]:border [&_th]:border-current/25 [&_th]:px-2 [&_th]:font-normal";

const said = cx(
  pxText.sm,
  "[&_code]:font-mono [&_h1]:text-[1.05em] [&_h2]:text-[1.05em] [&_h3]:text-[1.05em] [&_h4]:text-[1.05em] [&_h1,&_h2,&_h3,&_h4]:leading-[1.35] [&_h1,&_h2,&_h3,&_h4,&_h5,&_h6]:my-1.5 [&_h1,&_h2,&_h3,&_h4,&_h5,&_h6]:font-normal",
);

// Reading, a heading is the pixel font at a size it is sharp at: 24 for a title, 12 for a section, as the labels around it.
const reading = cx(
  pxText.read,
  "max-w-[560px] [&_code]:font-mono [&_code]:text-[0.9em] [&_h1,&_h2,&_h3,&_h4,&_h5,&_h6]:my-2 [&_h1,&_h2,&_h3,&_h4,&_h5,&_h6]:font-pixel [&_h1,&_h2,&_h3,&_h4,&_h5,&_h6]:font-normal [&_h1]:text-[24px] [&_h1]:leading-[1.3333] [&_h2,&_h3,&_h4,&_h5,&_h6]:text-[12px] [&_h2,&_h3,&_h4,&_h5,&_h6]:leading-[1.5]",
);

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
      tag.className = "inline-block bg-current/13 px-[0.3em] whitespace-nowrap";
      tag.append(...a.childNodes);
      a.replaceWith(tag);
      continue;
    }
    a.className = "underline decoration-current/45";
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
    line.className = "my-2 h-[1.5px] bg-[repeating-linear-gradient(to_right,currentColor_0_3px,transparent_3px_6px)] opacity-40";
    hr.replaceWith(line);
  }
  return [...root.childNodes];
}

/**
 * GitHub-flavoured, no raw HTML. With `mentions`, @w3, @管家, @主人 and @所有人 outside code are small tags. A link
 * goes to `onOpenLink` when given, else opens in a new tab. `reading`: long text in pxText.read at most 40 characters
 * a line; headings stay pixel, code stays mono. `class` carries the colour.
 */
export function PxMarkdown(props: { text: string; mentions?: boolean; onOpenLink?: (url: string) => void; reading?: boolean; class?: string }) {
  const nodes = createMemo(() => render(props.mentions === true ? withMentions(props.text) : props.text, props.onOpenLink));
  return <div class={[common, props.reading === true ? reading : said, props.class]}>{nodes()}</div>;
}

/** Plain text to read, as PxMarkdown with `reading` draws it. */
export function PxReadText(props: { text: string; maxLines?: number; class?: string }) {
  return (
    <p
      class={[pxText.read, "max-w-[560px] whitespace-pre-wrap", { "overflow-hidden": props.maxLines !== undefined }, props.class]}
      style={props.maxLines !== undefined ? { display: "-webkit-box", "-webkit-box-orient": "vertical", "-webkit-line-clamp": props.maxLines } : undefined}
    >
      {props.text}
    </p>
  );
}
