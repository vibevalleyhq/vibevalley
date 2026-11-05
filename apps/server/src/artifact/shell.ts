/** Kept in step with edit.ts's hidden: what the shell skips the server skips too, so prefix and suffix agree. */
const script = String.raw`(() => {
  const hidden = new Set(["HEAD", "SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "TEXTAREA", "TITLE"]);
  const context = 32;
  const texts = () => {
    const out = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        for (let p = n.parentElement; p; p = p.parentElement) if (hidden.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  };
  const indexOf = (nodes, container, offset) => {
    const point = document.createRange();
    point.setStart(container, offset);
    let at = 0;
    for (const t of nodes) {
      if (t === container) return at + offset;
      if (point.comparePoint(t, 0) >= 0) return at;
      at += t.data.length;
    }
    return at;
  };
  const anchor = () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const nodes = texts();
    const whole = nodes.map((t) => t.data).join("");
    const from = indexOf(nodes, range.startContainer, range.startOffset);
    const to = indexOf(nodes, range.endContainer, range.endOffset);
    const exact = whole.slice(from, to);
    if (exact.trim() === "") return null;
    return { kind: "text", exact, prefix: whole.slice(Math.max(0, from - context), from), suffix: whole.slice(to, to + context) };
  };
  let timer = 0;
  document.addEventListener("selectionchange", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      let found = null;
      try {
        found = anchor();
      } catch {}
      // A selection cleared says nothing: the workbench keeps the words it was given until the owner drops them.
      // To any origin: the frame cannot know the workbench's, and the message holds only the page's own words.
      if (found) parent.postMessage({ vibevalley: "selection", anchor: found }, "*");
    }, 150);
  });
})();`;

/** The page as the workbench shows it: the shell after everything else, so it runs once the page's own text is there. */
export const withShell = (page: string) => `${page}\n<script>${script}</script>\n`;
