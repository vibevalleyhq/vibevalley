export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gmu, "")
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/gu, "$2")
    .replaceAll("|", " ")
    .replace(/\s+/gu, " ")
    .trim();
}
