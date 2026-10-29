// The parts of ui/richText.ts that need no DOM: which links may stay links, and #12 as a link to its issue.

/** Past this many lines a code block starts folded. */
export const foldLines = 16;

/** A link may go only here: another site over http(s), mail, or a place of the app. javascript:, data: and the like
 * would run as the farm's page, or show what is not there. */
export const safeHref = (href: string) => /^(https?:|mailto:)/i.test(href) || (href.startsWith("/") && !href.startsWith("//")) || href.startsWith("#");

/** `#12` outside code and links: a link to issue 12. A remark plugin, for both renderers. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}
const issueRef = /(^|[\s(（,，、:：;；])#(\d{1,6})(?![\p{L}\p{N}_])/gu;
export const remarkIssueRefs = () => (tree: MdNode) => {
  const split = (value: string): MdNode[] => {
    const out: MdNode[] = [];
    let last = 0;
    for (const m of value.matchAll(issueRef)) {
      const at = m.index + m[1]!.length;
      if (at > last) out.push({ type: "text", value: value.slice(last, at) });
      out.push({ type: "link", url: `/issues/${m[2]}`, children: [{ type: "text", value: `#${m[2]}` }] });
      last = at + 1 + m[2]!.length;
    }
    if (last < value.length) out.push({ type: "text", value: value.slice(last) });
    return out;
  };
  const walk = (node: MdNode) => {
    if (!node.children || node.type === "link" || node.type === "linkReference") return;
    node.children = node.children.flatMap((c) => (c.type === "text" && c.value?.includes("#") ? split(c.value) : (walk(c), [c])));
  };
  walk(tree);
};

/** Markdown read as one plain line, for a preview where its marks (#, -, *, `, fences) would show as they are. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, "$2")
    .replaceAll("|", " ")
    .replace(/\s+/g, " ")
    .trim();
}
