// Sandboxed HTML/CSS/JS assembly for `prototype` artifacts.
// Never grants `allow-same-origin`; injects strict CSP meta with `connect-src 'none'`.

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

/** Assembles a self-contained, CSP-sandboxed document for a `prototype` artifact directory by inlining
 * local `./styles.css` and `./app.js` references from `structure/*` without network or same-origin access. */
export function buildPrototypeDocument(files: ReadonlyMap<string, string>): string {
  const rawHtml = files.get("structure/index.html") ?? '<!doctype html><html><head><meta charset="utf-8" /></head><body><main id="app"></main></body></html>';

  let assembled = rawHtml.replace(/<link\b[^>]*href=["'](?:\.\/)?([^"']+\.css)["'][^>]*>/giu, (match, rel: string) => {
    const css = files.get(`structure/${rel}`) ?? files.get(rel);
    return css !== undefined ? `<style>\n${escapeCloseTag(css, "style")}\n</style>` : match;
  });

  assembled = assembled.replace(
    /<script\b([^>]*)src=["'](?:\.\/)?([^"']+\.m?js)["']([^>]*)><\/script>/giu,
    (match, before: string, rel: string, after: string) => {
      const js = files.get(`structure/${rel}`) ?? files.get(rel);
      if (js === undefined) return match;
      const isModule = /\btype=["']module["']/iu.test(`${before} ${after}`);
      return `<script${isModule ? ' type="module"' : ""}>\n${escapeCloseTag(js, "script")}\n</script>`;
    },
  );

  return withPolicy(assembled);
}
