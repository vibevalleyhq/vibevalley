// Sandboxed HTML/CSS/JS assembly for `prototype` artifacts.
// Strict incognito WebView isolation (never shares host origin); injects strict CSP meta with `connect-src 'none'`.

const limits = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const policy = `<meta http-equiv="Content-Security-Policy" content="${limits}">`;

/** The policy as early in the page as it can go: after <head>, else after the doctype (a meta before it would put the
 * page in quirks mode), else first. */
export function withPolicy(page: string): string {
  const head = /<head(\s[^>]*)?>/iu.exec(page);
  if (head) return page.slice(0, head.index + head[0].length) + policy + page.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(page);
  if (doctype) return doctype[0] + policy + page.slice(doctype[0].length);
  return policy + page;
}

function escapeCloseTag(raw: string, tag: "style" | "script"): string {
  return raw.replace(new RegExp(`</${tag}`, "giu"), `<\\/${tag}`);
}

function lookupRelFile(files: ReadonlyMap<string, string>, rawRef: string): string | undefined {
  const normalized = rawRef.replace(/^(?:\.\.\/)+/u, "").replace(/^\.\//u, "");
  return files.get(`structure/${normalized}`) ?? files.get(normalized) ?? files.get(`asset/${normalized}`);
}

function pickHtmlEntry(files: ReadonlyMap<string, string>, entryPath?: string): string {
  if (entryPath !== undefined) {
    const chosen = files.get(entryPath);
    if (chosen !== undefined) return chosen;
  }
  const primary = files.get("structure/index.html");
  if (primary !== undefined) return primary;
  const fallbackKey = [...files.keys()]
    .filter((k) => /\.(?:html|htm)$/iu.test(k))
    .toSorted((a, b) => a.localeCompare(b))
    .at(0);
  if (fallbackKey !== undefined) {
    return files.get(fallbackKey) ?? '<!doctype html><html><head><meta charset="utf-8" /></head><body><main id="app"></main></body></html>';
  }
  return '<!doctype html><html><head><meta charset="utf-8" /></head><body><main id="app"></main></body></html>';
}

/** Assembles a self-contained, CSP-sandboxed document for a `prototype` or HTML artifact directory by inlining
 * local `.css`, `.js`/`.mjs`, and `.svg` references without network or same-origin access. */
export function buildPrototypeDocument(files: ReadonlyMap<string, string>, entryPath?: string): string {
  const rawHtml = pickHtmlEntry(files, entryPath);

  let assembled = rawHtml.replace(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/giu, (match, rel: string) => {
    const css = lookupRelFile(files, rel);
    return css !== undefined ? `<style>\n${escapeCloseTag(css, "style")}\n</style>` : match;
  });

  assembled = assembled.replace(/<img\b([^>]*)src=["']([^"']+\.svg)["']([^>]*)>/giu, (match, before: string, rel: string, after: string) => {
    const svg = lookupRelFile(files, rel);
    if (svg === undefined) return match;
    return `<img${before}src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}"${after}>`;
  });

  assembled = assembled.replace(/<script\b([^>]*)src=["']([^"']+\.m?js)["']([^>]*)><\/script>/giu, (match, before: string, rel: string, after: string) => {
    const js = lookupRelFile(files, rel);
    if (js === undefined) return match;
    const isModule = /\btype=["']module["']/iu.test(`${before} ${after}`);
    return `<script${isModule ? ' type="module"' : ""}>\n${escapeCloseTag(js, "script")}\n</script>`;
  });

  return withPolicy(assembled);
}
