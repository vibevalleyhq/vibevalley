import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MdNode {
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

/** @names in plain text (not in code or links) drawn as a span.mention. */
const remarkMentions = () => (tree: MdNode) => {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === "link") return;
    node.children = node.children.flatMap((c) => (c.type === "text" && c.value?.includes("@") ? splitMentions(c.value) : (walk(c), [c])));
  };
  walk(tree);
};

/** Chat text, descriptions and reports: GitHub markdown, at most 48 characters a line where it stands alone. */
export function Markdown({ text, className = "", mentions = false }: { text: string; className?: string; mentions?: boolean }) {
  return (
    <div
      className={`min-w-0 text-base break-words [&_a]:text-water [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_code]:rounded [&_code]:bg-hover [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12.5px] [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-hover [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-2 [&_td]:border [&_td]:border-line [&_td]:px-2 [&_th]:border [&_th]:border-line [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-5 [&_.mention]:rounded [&_.mention]:bg-[#5a823420] [&_.mention]:px-0.5 [&_.mention]:font-medium [&_.mention]:text-accent ${className}`}
    >
      <ReactMarkdown remarkPlugins={mentions ? [remarkGfm, remarkMentions] : [remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
