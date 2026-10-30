// Markdown read as one plain line, where its marks (#, -, *, `, fences) would show as they are: a card, a timeline, a
// preview. The server words an issue's timeline with it, the page its summary card, previews and the farm's bubbles.

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
