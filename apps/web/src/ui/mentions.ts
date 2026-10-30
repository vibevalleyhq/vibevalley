// @names in markdown text, for both renderers (ui/Markdown.tsx and solid/ui/Markdown.tsx).

export interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName: string; hProperties: Record<string, string> };
}

const mention = /(^|[^\p{L}\p{N}_@])(@[\p{L}\p{N}_-]+)/gu;

function splitMentions(value: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const m of value.matchAll(mention)) {
    const at = m.index + m[1]!.length;
    if (at > last) out.push({ type: "text", value: value.slice(last, at) });
    out.push({ type: "emphasis", data: { hName: "span", hProperties: { className: "mention" } }, children: [{ type: "text", value: m[2]! }] });
    last = at + m[2]!.length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/** A remark plugin: @names in plain text (not in code or links) become a span.mention. */
export const remarkMentions = () => (tree: MdNode) => {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === "link") return;
    node.children = node.children.flatMap((c) => (c.type === "text" && c.value?.includes("@") === true ? splitMentions(c.value) : (walk(c), [c])));
  };
  walk(tree);
};

/** The classes the rendered markdown wears, the same in both renderers. */
export const markdownClass =
  "min-w-0 text-base break-words [&_a]:text-water [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_code]:rounded [&_code]:bg-hover [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-hover [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-2 [&_td]:border [&_td]:border-line [&_td]:px-2 [&_th]:border [&_th]:border-line [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-5 [&_.mention]:rounded [&_.mention]:bg-accent/12 [&_.mention]:px-0.5 [&_.mention]:font-medium [&_.mention]:text-accent";
