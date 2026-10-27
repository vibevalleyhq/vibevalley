export const mentionHref = "#mention";

const codeParts = /(```[\s\S]*?```|`[^`\n]*`)/g;

const mention = /(^|[^\p{L}\p{N}_@])@(w\d+|管家|主人|所有人)/gu;

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
