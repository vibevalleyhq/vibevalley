import { createMemo } from "solid-js";
import { toDom } from "hast-util-to-dom";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type Plugin, unified } from "unified";
import { markdownClass, remarkMentions } from "./mentions";

// Raw HTML in the text is dropped (remark-rehype's default); the tree becomes DOM nodes directly, without innerHTML.
const plain = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);
const withMentions = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMentions as unknown as Plugin)
  .use(remarkRehype);

/** Chat text, descriptions and reports: GitHub markdown. */
export function Markdown(props: { text: string; class?: string; mentions?: boolean }) {
  const nodes = createMemo(() => {
    const md = props.mentions ? withMentions : plain;
    const tree = md.runSync(md.parse(props.text));
    return [...(toDom(tree, { fragment: true }) as DocumentFragment).childNodes];
  });
  return <div class={[markdownClass, props.class]}>{nodes()}</div>;
}
