import { type ArtifactDisplay, artifactPath, type HtmlAnchor, type HtmlShellMessage } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

/** The workbench theme the page is shown in: the frame cannot read the workbench's own setting. */
export const ShellThemeValues = ["light", "dark"] as const;
export type ShellTheme = (typeof ShellThemeValues)[number];

// Keep in sync with --wb-* tokens in apps/web/src/style.css.
const themeVariables: Record<ShellTheme, string> = {
  light:
    "color-scheme:light;--vv-page:#fcfcfb;--vv-side:#f6f5f3;--vv-ink:#1c1917;--vv-muted:#5e5852;--vv-faint:#716a64;--vv-line:#1c191714;--vv-accent:#4d7a2a;--vv-leaf:#74a046;--vv-wheat:#e5a93c;--vv-berry:#a83a2c;--vv-water:#2f6fa8;",
  dark: "color-scheme:dark;--vv-page:#151413;--vv-side:#1b1a18;--vv-ink:#ecebe8;--vv-muted:#a9a49e;--vv-faint:#8b867f;--vv-line:#ecebe81a;--vv-accent:#7fae4f;--vv-leaf:#8dbb5c;--vv-wheat:#e5a93c;--vv-berry:#e47d6d;--vv-water:#6aa6dc;",
};
const typeVariables =
  '--vv-font-sans:"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;--vv-font-mono:Menlo,ui-monospace,monospace;--vv-radius:8px;';

const selectionScript = String.raw`(() => {
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
      } catch {
        found = null;
      }
      if (found) parent.postMessage({ vibevalley: "selection", anchor: found }, "*");
    }, 150);
  });
})();`;

const runtimeScript = String.raw`(config) => {
  const say = (message) => parent.postMessage(Object.assign({ vibevalley: message.kind }, message.body), "*");
  const commands = {};
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const d = e.data;
    if (!d || typeof d !== "object" || typeof d.vibevalley !== "string") return;
    const run = Object.prototype.hasOwnProperty.call(commands, d.vibevalley) ? commands[d.vibevalley] : undefined;
    if (run) run(d);
  });
  const asked = new URLSearchParams(location.search);
  const displays = {
    page: () => say({ kind: "ready", body: { display: "page" } }),
    slides: () => {
      const all = Array.from(document.querySelectorAll("section")).filter((s) => !s.parentElement || !s.parentElement.closest("section"));
      if (all.length === 0) return displays.page();
      const root = document.documentElement;
      root.classList.add("vv-slides");
      const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim().slice(0, 500) : "");
      const titles = all.map((s) => text(s.querySelector("h1, h2, h3")));
      const notes = all.map((s) => text(s.querySelector("aside.notes")));
      if (asked.get("print") === "1") {
        root.classList.add("vv-print");
        addEventListener("load", () => setTimeout(() => print(), 300));
        return say({ kind: "ready", body: { display: "slides", pages: all.length, titles, notes } });
      }
      const fit = () => {
        const k = Math.min(innerWidth / 1280, innerHeight / 720);
        for (const s of all) s.style.setProperty("--vv-scale", String(k));
      };
      let at = -1;
      const show = (n) => {
        const next = Math.max(0, Math.min(all.length - 1, n));
        if (next === at) return;
        at = next;
        all.forEach((s, i) => s.classList.toggle("vv-on", i === at));
        say({ kind: "at", body: { page: at } });
      };
      commands.goto = (d) => {
        if (Number.isInteger(d.page)) show(d.page);
      };
      addEventListener("resize", fit);
      fit();
      const first = Number(asked.get("at"));
      show(Number.isInteger(first) ? first : 0);
      if (asked.get("still") !== "1") {
        addEventListener("keydown", (e) => {
          if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
          const step = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }[e.key];
          if (step) {
            e.preventDefault();
            show(at + step);
          } else if (e.key === "Home") show(0);
          else if (e.key === "End") show(all.length - 1);
        });
        addEventListener("click", (e) => {
          if (e.target && e.target.closest && e.target.closest("a, button, input, textarea, select, summary, video, audio, [contenteditable]")) return;
          if (getSelection() && !getSelection().isCollapsed) return;
          show(at + (e.clientX < innerWidth / 4 ? -1 : 1));
        });
      }
      say({ kind: "ready", body: { display: "slides", pages: all.length, titles, notes } });
    },
  };
  const start = () => (displays[config.display] || displays.page)();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}`;

// Zero-specificity :where() selectors let deck-authored CSS override defaults.
const slideStyles = String.raw`
:where(html.vv-slides),:where(html.vv-slides) :where(body){margin:0;height:100%;overflow:hidden;background:var(--vv-side);color:var(--vv-ink);font-family:var(--vv-font-sans);-webkit-font-smoothing:antialiased}
:where(html.vv-slides) :where(section){position:absolute;left:50%;top:50%;width:1280px;height:720px;box-sizing:border-box;padding:80px 112px;display:none;flex-direction:column;justify-content:center;gap:28px;background:var(--vv-page);transform:translate(-50%,-50%) scale(var(--vv-scale,1));transform-origin:center;overflow:hidden}
:where(html.vv-slides) :where(section.vv-on){display:flex}
:where(html.vv-slides) :where(section) :where(h1){margin:0;font-size:72px;line-height:1.1;font-weight:700;letter-spacing:-0.01em}
:where(html.vv-slides) :where(section) :where(h2){margin:0;font-size:48px;line-height:1.15;font-weight:650}
:where(html.vv-slides) :where(section) :where(h3){margin:0;font-size:32px;line-height:1.2;font-weight:600;color:var(--vv-muted)}
:where(html.vv-slides) :where(section) :where(p,li){margin:0;font-size:30px;line-height:1.5}
:where(html.vv-slides) :where(section) :where(ul,ol){margin:0;padding-left:1.2em;display:flex;flex-direction:column;gap:14px}
:where(html.vv-slides) :where(section) :where(li)::marker{color:var(--vv-leaf)}
:where(html.vv-slides) :where(section) :where(small,figcaption,.muted){font-size:22px;color:var(--vv-muted)}
:where(html.vv-slides) :where(section) :where(code){font-family:var(--vv-font-mono);font-size:0.9em;padding:0.1em 0.3em;border-radius:6px;background:var(--vv-line)}
:where(html.vv-slides) :where(section) :where(img,video,svg){max-width:100%;max-height:100%;border-radius:var(--vv-radius)}
:where(html.vv-slides) :where(section) :where(aside.notes){display:none}
:where(html.vv-slides) :where(section.title){align-items:flex-start;justify-content:flex-end;padding-bottom:112px}
:where(html.vv-slides) :where(section.title) :where(h1){font-size:88px}
:where(html.vv-slides) :where(section.title)::before{content:"";width:72px;height:6px;border-radius:3px;background:var(--vv-accent);margin-bottom:8px}
:where(html.vv-slides) :where(section.two-col){display:none;grid-template-columns:1fr 1fr;grid-template-rows:auto 1fr;column-gap:64px;row-gap:36px;align-content:center}
:where(html.vv-slides) :where(section.two-col.vv-on){display:grid}
:where(html.vv-slides) :where(section.two-col) > :where(h1,h2,h3){grid-column:1 / -1}
:where(html.vv-slides) :where(section.two-col) > :where(div){display:flex;flex-direction:column;gap:16px;min-width:0}
:where(html.vv-slides) :where(section.image){padding:56px;align-items:center;gap:20px}
:where(html.vv-slides) :where(section.image) :where(img,video,svg){flex:1;min-height:0;object-fit:contain}
:where(html.vv-slides) :where(section.quote){padding:96px 160px}
:where(html.vv-slides) :where(section.quote) :where(blockquote){margin:0;padding-left:40px;border-left:8px solid var(--vv-wheat);font-size:48px;line-height:1.4;font-weight:500}
:where(html.vv-slides) :where(section.quote) :where(cite,figcaption){font-style:normal;font-size:26px;color:var(--vv-muted)}
@page{size:1280px 720px;margin:0}
@media print{
  :where(html.vv-slides),:where(html.vv-slides) :where(body){height:auto;overflow:visible;background:none}
  :where(html.vv-slides) :where(section){position:relative;left:auto;top:auto;transform:none;display:flex;break-after:page;page-break-after:always}
  :where(html.vv-slides) :where(section.two-col){display:grid}
}`;

const displayStyles: Record<ArtifactDisplay, string> = { page: "", slides: slideStyles, motion: "" };

export const withShell = (shown: { readonly page: string; readonly display: ArtifactDisplay; readonly theme: ShellTheme }) => `${shown.page}
<style>:root{${themeVariables[shown.theme]}${typeVariables}}${displayStyles[shown.display]}</style>
<script>${selectionScript}</script>
<script>(${runtimeScript})({ display: "${shown.display}" })</script>
`;

/** Includes `display` and `theme` in the query string because version responses are cached immutable. */
export const shellPath = (
  id: string,
  version: number,
  display: ArtifactDisplay = "page",
  theme: ShellTheme = "light",
  more: { readonly at?: number; readonly still?: boolean; readonly print?: boolean } = {},
) =>
  `${artifactPath(id, version)}?shell=1&display=${display}&theme=${theme}${more.at === undefined ? "" : `&at=${more.at}`}${more.still === true ? "&still=1" : ""}${more.print === true ? "&print=1" : ""}`;

export const shellThemeOf = (asked: string | null): ShellTheme => (asked === "dark" ? "dark" : "light");

export const shellMessageOf = (data: unknown): HtmlShellMessage | undefined => {
  const got = S.HtmlShellMessage.safeParse(data);
  return got.success ? got.data : undefined;
};

const wordsMax = 10_000;
const contextMax = 64;

export function selectionOf(data: unknown): HtmlAnchor | undefined {
  const message = shellMessageOf(data);
  if (message?.vibevalley !== "selection") return undefined;
  const { anchor } = message;
  return anchor.exact.length > wordsMax || anchor.prefix.length > contextMax || anchor.suffix.length > contextMax ? undefined : anchor;
}
