import type { JSX } from "@solidjs/web";
import type * as stylex from "@stylexjs/stylex";
import { toDom } from "hast-util-to-dom";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { createMemo, onCleanup } from "solid-js";
import { type Plugin, unified } from "unified";

import { useRouter } from "#/infra/router.ts";

import { withStyles } from "./positioner";
import { fragmentOf, remarkIssueRefs, remarkMentions, richen } from "./richText";

// Raw HTML in the text is dropped (remark-rehype's default); the tree becomes DOM nodes directly, without innerHTML.
const plain = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MdNode types only the mdast fields the plugin reads and writes
  .use(remarkIssueRefs as unknown as Plugin)
  .use(remarkRehype);
const withMentions = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MdNode types only the mdast fields the plugin reads and writes
  .use(remarkMentions as unknown as Plugin)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MdNode types only the mdast fields the plugin reads and writes
  .use(remarkIssueRefs as unknown as Plugin)
  .use(remarkRehype);

/** Chat text, descriptions and reports: GitHub markdown, made richer in place (richText.ts): safe links, code, Mermaid. */
export function Markdown(props: {
  text: string;
  class?: JSX.ClassValue | undefined;
  // For callers still on StyleX; it goes when the last of them is on classes.
  styles?: stylex.StyleXStyles;
  mentions?: boolean;
}) {
  const appearance = () => withStyles(props.styles, ["markdown min-w-0 text-base wrap-break-word", props.class]);
  const router = useRouter();
  // Read through a memo of the text alone.
  const text = createMemo(() => props.text);
  const nodes = createMemo(() => {
    const md = props.mentions === true ? withMentions : plain;
    const tree = md.runSync(md.parse(text()));
    const root = fragmentOf(toDom(tree, { fragment: true }));
    onCleanup(richen(root, { navigate: (to) => router.navigate(to) }));
    return [...root.childNodes];
  });
  return <div {...appearance()}>{nodes()}</div>;
}
