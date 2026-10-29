// A report or a message written in Markdown, said in one plain line where there is room for one line: its marks (#, **,
// `, links, list bullets) taken off, its lines joined. The server words an issue's timeline with it, the page a summary
// card and a thread's preview.

export function plainLine(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, "")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
        .replace(/`([^`]+)`/g, "$1")
        .trim(),
    )
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
}
