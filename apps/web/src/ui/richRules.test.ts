import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type Plugin, unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkIssueRefs, safeHref } from "./richRules";

interface Hast {
  type: string;
  tagName?: string | undefined;
  value?: string | undefined;
  properties?: { href?: string | undefined } | undefined;
  children?: Hast[] | undefined;
}
const textOf = (n: Hast): string => n.value ?? (n.children ?? []).map(textOf).join("");
/** Each link in the rendered tree, as its words and where it goes. */
const links = (md: string) => {
  const p = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkIssueRefs as unknown as Plugin)
    .use(remarkRehype);
  const out: string[] = [];
  const walk = (n: Hast) => {
    if (n.tagName === "a") out.push(`${textOf(n)}→${n.properties?.href}`);
    else (n.children ?? []).forEach(walk);
  };
  walk(p.runSync(p.parse(md)));
  return out;
};

describe("rich text's rules", () => {
  it("keeps only links that cannot run as the page", () => {
    for (const ok of ["https://a.dev/x", "http://a.dev", "mailto:a@b.c", "/issues/12", "#mention"]) expect([ok, safeHref(ok)]).toEqual([ok, true]);
    for (const bad of ["javascript:alert(1)", "JavaScript:x", "data:text/html,x", "vbscript:x", "//evil.dev/x", "file:///etc/hosts", ""])
      expect([bad, safeHref(bad)]).toEqual([bad, false]);
  });

  it("links #12 to its issue, outside code, links and words", () => {
    expect(links("看 #12，和（#3）")).toEqual(["#12→/issues/12", "#3→/issues/3"]);
    expect(links("a#3 和 #4x 和 `#5` 和 [#6](https://x.dev)")).toEqual(["#6→https://x.dev"]);
    expect(links("#7 开头")).toEqual(["#7→/issues/7"]);
    // A heading's # is the syntax, not a reference.
    expect(links("# 12")).toEqual([]);
  });
});
