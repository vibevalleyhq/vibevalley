import { createMemo, onCleanup } from "solid-js";
import { toDom } from "hast-util-to-dom";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type Plugin, unified } from "unified";
import { markdownClass, remarkMentions } from "./mentions";
import { richen } from "./richText";
import { remarkIssueRefs } from "./richRules";
import { useRouter } from "../base/router";

// Raw HTML in the text is dropped (remark-rehype's default); the tree becomes DOM nodes directly, without innerHTML.
const plain = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkIssueRefs as unknown as Plugin)
  .use(remarkRehype);
const withMentions = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMentions as unknown as Plugin)
  .use(remarkIssueRefs as unknown as Plugin)
  .use(remarkRehype);

/** Chat text, descriptions and reports: GitHub markdown, made richer in place (richText.ts): safe links, code, Mermaid. */
export function Markdown(props: { text: string; class?: string; mentions?: boolean }) {
  const router = useRouter();
  const nodes = createMemo(() => {
    const md = props.mentions ? withMentions : plain;
    const tree = md.runSync(md.parse(props.text));
    const root = toDom(tree, { fragment: true }) as DocumentFragment;
    onCleanup(richen(root, { navigate: (to) => router.navigate(to) }));
    return [...root.childNodes];
  });
  return <div class={[markdownClass, props.class]}>{nodes()}</div>;
}
