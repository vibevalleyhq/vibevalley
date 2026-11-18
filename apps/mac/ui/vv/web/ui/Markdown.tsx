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
  blockquote: "my-0 border-l-2 border-line pl-3 text-muted",
  code: "rounded-sm border-0 bg-hover px-1 font-mono text-xs",
  heading: "mt-0 mb-0 font-semibold",
  heading1: "text-lg",
  paragraph: "my-1",
  list: "my-0 pl-5",
  listItem: "my-0.5",
  listItemContent: "gap-0",
  taskMarker: "mt-1 size-3.5",
  table: "my-2",
  tableHead: "bg-transparent",
  tableCell: "border border-line px-2 py-0",
  tableHeaderCell: "bg-transparent font-semibold text-ink",
  rule: "my-2 border-line",
};

/** h2 to h6 at the text's own size, as Markdown.css leaves them. */
const headings = (size: string) => ({ heading2: size, heading3: size, heading4: size, heading5: size, heading6: size });

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
  return (
    <TextView
      markdown={richenText(props.text, props.mentions === true)}
      selectable
      classes={{
        ...classes,
        ...headings(props.size === "sm" ? "text-sm" : "text-base"),
        root: `min-w-0 gap-0 text-ink ${props.size === "sm" ? "text-sm" : "text-base"} ${props.class ?? ""}`,
      }}
      renderCodeBlock={(block) => (block.language === "mermaid" ? <Diagram source={block.code} /> : <CodeBlock code={block.code} language={block.language} />)}
      onLinkPress={(e) => {
        if (e.url.startsWith("/")) router.navigate(e.url);
        else void hostApi.openUrl(e.url);
      }}
    />
  );
}
