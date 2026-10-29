// Markdown read as one plain line, where its marks (#, -, *, `, fences) would show as they are: a card, a timeline, a
// preview. The server words an issue's timeline with it, the page its summary card, previews and the farm's bubbles.

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
