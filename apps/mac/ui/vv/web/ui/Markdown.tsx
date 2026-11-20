// Ported from VibeValley apps/web/src/ui/Markdown.tsx: GitHub markdown,
// drawn by nsh/base's TextView with Markdown.css's look as its classes.
// Issue numbers (#12) become links to the issue and @mentions are tinted
// by rewriting the text before it is parsed. TextView's own reading
// typography (15pt, headings with room above, bordered code) is set back to
// Markdown.css on Tailwind's preflight: headings at the text's size but h1,
// no margins but the ones it gives. Code blocks are richText.ts's (code/
// CodeBlock), Mermaid blocks its diagrams (code/Diagram).
import { TextView } from "nsh/base";

import { hostApi } from "../../../bridge";
import { useRouter } from "../infra/router";
import { CodeBlock } from "./code/CodeBlock";
import { Diagram } from "./code/Diagram";

const classes = {
  link: "text-water underline",
  strong: "font-semibold text-ink",
  blockquote: "my-1 border-l-2 border-faint py-0.5 pl-3 text-muted",
  alert: "my-1.5 rounded-md border border-line bg-side px-3 py-1.5",
  code: "rounded-sm border border-line bg-side px-1.5 py-px font-mono text-xs text-ink",
  keyboard: "rounded-xs border border-line bg-side px-1 py-px font-mono text-2xs text-ink",
  heading: "mt-1 mb-0.5 font-semibold text-ink",
  paragraph: "my-1",
  list: "my-0.5 pl-5",
  listItem: "my-0.5 items-start",
  listMarker: "text-muted tabular-nums",
  listItemContent: "min-w-0 flex-1 gap-0",
  taskMarker: "mt-0.5 size-3.5 rounded-xs border border-faint bg-page",
  taskMarkerChecked: "border-accent bg-accent text-page",
  table: "my-2 overflow-hidden rounded-md border border-line",
  tableHead: "bg-side",
  tableRow: "border-b border-line",
  tableCell: "border border-line px-2 py-1 text-ink",
  tableHeaderCell: "bg-side font-semibold text-ink",
  rule: "my-2 border-line",
};

/** Compact workbench heading scale matching the surrounding text size. */
const headings = (sm: boolean) =>
  sm
    ? { heading1: "text-base", heading2: "text-sm", heading3: "text-sm", heading4: "text-sm", heading5: "text-sm", heading6: "text-sm" }
    : { heading1: "text-lg", heading2: "text-base", heading3: "text-sm", heading4: "text-sm", heading5: "text-sm", heading6: "text-sm" };

/** `#12` outside code and links becomes a link to /issues/12; `@name` with mentions becomes **@name**. */
function richenText(text: string, mentions: boolean): string {
  return text
    .split(/(```[\s\S]*?```|`[^`]*`|\[[^\]]*\]\([^)]*\))/u)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let out = part.replace(/(^|[\s(（，。,])#(\d+)\b/gu, (_, pre: string, n: string) => `${pre}[#${n}](/issues/${n})`);
      if (mentions) out = out.replace(/(^|\s)@([\p{L}\p{N}_-]+)/gu, (_, pre: string, name: string) => `${pre}**@${name}**`);
      return out;
    })
    .join("");
}

/** Chat text, descriptions and reports. */
export function Markdown(props: { text: string; class?: string | undefined; size?: "base" | "sm"; mentions?: boolean }) {
  const router = useRouter();
  const small = () => props.size === "sm";
  return (
    <TextView
      markdown={richenText(props.text, props.mentions === true)}
      selectable
      classes={{
        ...classes,
        ...headings(small()),
        root: `min-w-0 gap-0 text-ink ${small() ? "text-sm" : "text-base"} ${props.class ?? ""}`,
      }}
      renderCodeBlock={(block) => (block.language === "mermaid" ? <Diagram source={block.code} /> : <CodeBlock code={block.code} language={block.language} />)}
      onLinkPress={(e) => {
        if (e.url.startsWith("/")) router.navigate(e.url);
        else void hostApi.openUrl(e.url);
      }}
    />
  );
}
