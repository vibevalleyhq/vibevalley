import { Option, Schema } from "effect";

import { type ArtifactDisplay, artifactPath, type HtmlAnchor, type HtmlShellMessage } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

/** The workbench theme the page is shown in: the frame cannot read the workbench's own setting. */
export const ShellThemeValues = ["light", "dark"] as const;
export type ShellTheme = (typeof ShellThemeValues)[number];

// The workbench's colours (apps/web/src/style.css, its --wb-* values) and type, as variables a page may use: what the
// runtime draws uses them, and a page that wants to look like the workbench can too. Keep them in step with style.css.
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

// The vv runtime: it lays the page out for its display, tells the shell what it is (ready) and where it is (at), and
// does what the shell asks (goto, seek, play, pause). It only ever posts to its parent and only listens to its parent.
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
  const displays = {
    page: () => say({ kind: "ready", body: { display: "page" } }),
  };
  const start = () => (displays[config.display] || displays.page)();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}`;

const displayStyles: Record<ArtifactDisplay, string> = { page: "", slides: "", motion: "" };

/** The page as the workbench shows it: the runtime and the selection after everything else, so they run once the page's
 * own text is there. Their styles use :where(), so whatever the page says of the same elements wins. */
export const withShell = (shown: { readonly page: string; readonly display: ArtifactDisplay; readonly theme: ShellTheme }) => `${shown.page}
<style>:root{${themeVariables[shown.theme]}${typeVariables}}${displayStyles[shown.display]}</style>
<script>${selectionScript}</script>
<script>(${runtimeScript})({ display: "${shown.display}" })</script>
`;

/** The workbench's view of a version. The display and theme are in the address because a version's response is cached for
 * good: the same version shown another way, or in the other theme, is another response. The server reads the display from
 * the artifact, not from here. */
export const shellPath = (id: string, version: number, display: ArtifactDisplay = "page", theme: ShellTheme = "light") =>
  `${artifactPath(id, version)}?shell=1&display=${display}&theme=${theme}`;

/** The theme a shell request asks for; light when it names none it knows. */
export const shellThemeOf = (asked: string | null): ShellTheme => (asked === "dark" ? "dark" : "light");

const decodeShellMessage = Schema.decodeUnknownOption(S.HtmlShellMessage);

/** What a page's message says, when it is one of the protocol's; undefined for anything else. */
export const shellMessageOf = (data: unknown): HtmlShellMessage | undefined => Option.getOrUndefined(decodeShellMessage(data));

const wordsMax = 10_000;
const contextMax = 64;

/** The words the user selected, as the message tells of them; undefined when it is no such message. */
export function selectionOf(data: unknown): HtmlAnchor | undefined {
  const message = shellMessageOf(data);
  if (message?.vibevalley !== "selection") return undefined;
  const { anchor } = message;
  return anchor.exact.length > wordsMax || anchor.prefix.length > contextMax || anchor.suffix.length > contextMax ? undefined : anchor;
}
