// What Markdown becomes, for both renderers (ui/Markdown.tsx, ui/pixel/PxMarkdown.tsx): `@names` and `#12` made into
// mentions and links in the tree before its DOM, then the DOM's links made safe and kept in the app, fenced code with
// its language, a copy button, colours and a fold, Mermaid drawn
// by Pele, task lists that read as lists. Messages, reports, descriptions and artifacts are agents' words: nothing here
// may let them run as the farm's page.

import type { MountOptions, Mounted } from "pele/lazy";

import { t } from "@vibevalley/i18n";

import { messageOf } from "@/base/format";

import { highlight } from "./code/highlight";
import { icons } from "./icons";

/** Past this many lines a code block starts folded. */
const foldLines = 16;

/** A link may go only here: another site over http(s), mail, or a place of the app. javascript:, data: and the like
 * would run as the farm's page, or show what is not there. */
export const safeHref = (href: string) => /^(https?:|mailto:)/iu.test(href) || (href.startsWith("/") && !href.startsWith("//")) || href.startsWith("#");

/** `#12` outside code and links: a link to issue 12. A remark plugin, for both renderers. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hName: string; hProperties: Record<string, string> };
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
    node.children = node.children.flatMap((c) => (c.type === "text" && c.value?.includes("#") === true ? split(c.value) : (walk(c), [c])));
  };
  walk(tree);
};

const mention = /(^|[^\p{L}\p{N}_@])(@[\p{L}\p{N}_-]+)/gu;
function splitMentions(value: string): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const m of value.matchAll(mention)) {
    const at = m.index + m[1]!.length;
    if (at > last) out.push({ type: "text", value: value.slice(last, at) });
    out.push({ type: "emphasis", data: { hName: "span", hProperties: { className: "mention" } }, children: [{ type: "text", value: m[2]! }] });
    last = at + m[2]!.length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/** `@name` in plain text (not in code or links) becomes a span.mention. A remark plugin, for both renderers. */
export const remarkMentions = () => (tree: MdNode) => {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === "link") return;
    node.children = node.children.flatMap((c) => (c.type === "text" && c.value?.includes("@") === true ? splitMentions(c.value) : (walk(c), [c])));
  };
  walk(tree);
};

/** The classes the rendered markdown wears, the same in both renderers. */
export const markdownClass =
  "min-w-0 text-base break-words [&_a]:text-water [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_code]:rounded [&_code]:bg-hover [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-hover [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-2 [&_td]:border [&_td]:border-line [&_td]:px-2 [&_th]:border [&_th]:border-line [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-5 [&_.mention]:rounded [&_.mention]:bg-accent/12 [&_.mention]:px-0.5 [&_.mention]:font-medium [&_.mention]:text-accent";

interface RichOptions {
  /** A link inside the app (a path) goes here instead of reloading the page; absent, it opens as a plain link. */
  readonly navigate?: (to: string) => void;
  /** The pixel skin: code keeps the text's colour, uncoloured. */
  readonly pixel?: boolean;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const iconOf = (name: "copy" | "expand" | "check", size = 14): Node => {
  const icon: unknown = icons[name === "check" ? "check" : name]({ size });
  if (!(icon instanceof Node)) throw new TypeError("an icon renders to one element");
  return icon;
};

/** An SVG string as nodes, with nothing that could run or reach out: no scripts, no foreign HTML, no event handlers, no
 * links but in-page ones. Pele escapes and filters too (links and images off); this is the page's own guarantee. */
function cleanSvg(svg: string): Node {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg") return document.createTextNode("");
  for (const bad of [...root.querySelectorAll("script, foreignObject, iframe, object, embed, a, image")])
    bad.replaceWith(...(bad.nodeName === "a" ? [...bad.childNodes] : []));
  for (const e of [root, ...root.querySelectorAll("*")])
    for (const a of [...e.attributes]) {
      const name = a.name.toLowerCase();
      if (name.startsWith("on")) e.removeAttribute(a.name);
      else if ((name === "href" || name === "xlink:href") && !a.value.startsWith("#")) e.removeAttribute(a.name);
      else if (name === "style" && /url\(|expression|@import/iu.test(a.value)) e.removeAttribute(a.name);
    }
  return document.importNode(root, true);
}

/** The work richen starts that outlives it: diagrams' observers, unmounted with the nodes. */
export type Undo = () => void;

/** toDom's answer as a fragment: it gives one for { fragment: true }, typed as any node. */
export function fragmentOf(node: Node): DocumentFragment {
  if (node instanceof DocumentFragment) return node;
  const f = document.createDocumentFragment();
  f.append(node);
  return f;
}

/** Rewrites rendered Markdown in place. Returns what to undo when the nodes go. */
export function richen(root: ParentNode, o: RichOptions = {}): Undo {
  const undo: Undo[] = [];
  links(root, o);
  for (const box of [...root.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]) {
    box.setAttribute("aria-readonly", "true");
    box.setAttribute("aria-label", box.checked ? t("web.base.rich.taskDone") : t("web.base.rich.taskOpen"));
    box.closest("li")?.classList.add("task");
  }
  for (const code of [...root.querySelectorAll("pre > code")]) {
    const pre = code.parentElement!;
    const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "";
    const text = code.textContent.replace(/\n$/u, "");
    if (lang === "mermaid") undo.push(diagram(pre, text));
    else codeBlock(pre, code, lang, text, o);
  }
  return () => undo.forEach((u) => u());
}

function links(root: ParentNode, o: RichOptions) {
  for (const a of [...root.querySelectorAll("a")]) {
    const href = a.getAttribute("href") ?? "";
    if (!safeHref(href)) {
      const words = document.createElement("span");
      words.append(...a.childNodes);
      a.replaceWith(words);
      continue;
    }
    if (href.startsWith("/") && o.navigate) {
      const go = o.navigate;
      a.dataset.inApp = "";
      a.addEventListener("click", (e: MouseEvent) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        go(href);
      });
    } else if (/^https?:/iu.test(href)) {
      a.target = "_blank";
      a.rel = "noreferrer noopener";
    }
  }
}

function codeBlock(pre: HTMLElement, code: Element, lang: string, text: string, o: RichOptions) {
  const lines = text.split("\n");
  const box = el("div", "code-block", undefined);
  box.dataset.testid = "code-block";
  if (lang) box.dataset.lang = lang;
  const head = el("div", "code-head");
  head.append(el("span", "code-lang", lang || t("web.base.rich.lines", { n: lines.length })));
  const copy = el("button", "code-act");
  copy.type = "button";
  copy.dataset.testid = "code-copy";
  copy.setAttribute("aria-label", t("web.base.rich.copy"));
  copy.title = t("web.base.rich.copy");
  copy.append(iconOf("copy"));
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(text).then(() => {
      copy.replaceChildren(iconOf("check"));
      copy.title = t("web.base.rich.copied");
      // oxlint-disable-next-line vibevalley/dropped-timer -- it only changes its own button back, harmless once the button is gone
      setTimeout(() => {
        copy.replaceChildren(iconOf("copy"));
        copy.title = t("web.base.rich.copy");
      }, 1500);
    });
  });
  head.append(copy);
  pre.replaceWith(box);
  // A long line scrolls sideways: the keyboard reaches it too.
  pre.tabIndex = 0;
  box.append(head, pre);
  if (lines.length > foldLines) {
    box.dataset.folded = "";
    const more = el("button", "code-more", t("web.base.rich.more"));
    more.type = "button";
    more.dataset.testid = "code-more";
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", () => {
      const open = box.dataset.folded !== undefined;
      if (open) delete box.dataset.folded;
      else box.dataset.folded = "";
      more.textContent = open ? t("web.base.rich.less") : t("web.base.rich.more");
      more.setAttribute("aria-expanded", open ? "true" : "false");
    });
    box.append(more);
  }
  if (o.pixel === true || !lang) return;
  void highlight(lines, lang).then((tokens) => {
    if (!tokens || !code.isConnected) return;
    code.replaceChildren(
      ...tokens.flatMap((line, i) => [
        ...line.map((tok) => {
          const s = document.createElement("span");
          if (tok.color) s.style.color = tok.color;
          s.textContent = tok.text;
          return s;
        }),
        ...(i < tokens.length - 1 ? [document.createTextNode("\n")] : []),
      ]),
    );
    code.parentElement?.setAttribute("data-coloured", "");
  });
}

/** A Mermaid block drawn by Pele, loaded the first time one is shown; while it loads, or when it cannot be drawn, the
 * source stays, with why. */
function diagram(pre: HTMLElement, text: string): Undo {
  const box = el("div", "diagram");
  box.dataset.testid = "diagram";
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", t("web.base.rich.diagram"));
  pre.replaceWith(box);
  box.append(pre);
  let mounted: Mounted | undefined;
  let gone = false;
  const options: MountOptions = {
    links: false,
    images: false,
    responsive: true,
    zoom: "auto",
    sanitize: cleanSvg,
  };
  void import("pele/lazy")
    .then(async ({ mountAsync, renderAsync }) => {
      // Parsed first: a block that cannot be drawn keeps its source, said as such, instead of an empty frame.
      await renderAsync(text, options);
      if (gone) return;
      const stage = el("div", "diagram-stage");
      mounted = await mountAsync(stage, text, options);
      if (gone) return mounted.destroy();
      box.replaceChildren(stage);
      box.dataset.drawn = "";
    })
    .catch((e: unknown) => {
      if (gone) return;
      box.dataset.failed = "";
      box.append(el("p", "diagram-error", t("web.base.rich.diagramFailed", { why: messageOf(e) })));
    });
  return () => {
    gone = true;
    mounted?.destroy();
  };
}
