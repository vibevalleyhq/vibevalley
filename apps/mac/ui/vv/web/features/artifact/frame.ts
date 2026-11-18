// Ported from VibeValley apps/web/src/features/artifact/frame.ts. There an
// html version is an <iframe> whose shell runtime talks by postMessage to
// its parent. Here it is an nsh WebView (a WKWebView in the GPUI host)
// given the whole page as `html`: at the top of a web view `parent` is the
// page's own window, so the shell's `parent.postMessage` lands on itself,
// and `shim` (run before the page's scripts) hands those messages out
// through `window.nsh.postMessage` (the WebView's onMessage). Commands go in
// as a message the page posts to itself (`injectJavaScript`), which the
// runtime takes since its source is `parent`.
import { signal, type Accessor, type WebViewRef } from "nsh";

import { type ShellTheme, withShell } from "@vibevalley/artifact/shell";
import type { ArtifactDisplay, HtmlAnchor, HtmlShellMessage } from "@vibevalley/protocol";

import { selectionOf, shellMessageOf } from "./shell";

/** What the page's runtime last said: what it is (ready) and where it is (at). */
export interface Shown {
  readonly ready?: Extract<HtmlShellMessage, { vibevalley: "ready" }>;
  readonly at?: Extract<HtmlShellMessage, { vibevalley: "at" }>;
}

/** What goes into the page: the protocol's one command. */
export type HtmlShellCommand = { readonly vibevalley: "goto"; readonly page: number };

export const shim = String.raw`(() => {
  const out = (d) => {
    try {
      window.nsh.postMessage(JSON.stringify(d));
    } catch {}
  };
  addEventListener("message", (e) => {
    const d = e.data;
    if (e.source === window && d && typeof d === "object" && typeof d.vibevalley === "string" && d.vibevalley !== "goto") out(d);
  });
})();`;

// What VibeValley's server sends as the page's Content-Security-Policy (packages/artifact/src/html.ts htmlLimits, which
// is not vendored: it parses with parse5); `sandbox` cannot be said in a meta, the web view's own store (incognito)
// keeps the page from the app's.
const limits = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com",
  "img-src data: blob:",
  "font-src data: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.gstatic.com",
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

/** The page a web view shows: the version as made, with its policy and the shell's theme, styles and runtime. `at` and
 * `still` are the runtime's query string in VibeValley (shellPath): here they are set before it reads them. */
export function framed(shown: {
  readonly page: string;
  readonly display: ArtifactDisplay;
  readonly theme: ShellTheme;
  readonly at?: number;
  readonly still?: boolean;
}): string {
  const asked = new URLSearchParams();
  if (shown.at !== undefined) asked.set("at", String(shown.at));
  if (shown.still === true) asked.set("still", "1");
  const whole = withShell({ page: withPolicy(shown.page), display: shown.display, theme: shown.theme });
  // The runtime reads `location.search`, which a page given as html does not have: it reads the asked one instead. The
  // runtime is last in the page, so the last such read is its.
  const read = "new URLSearchParams(location.search)";
  const at = whole.lastIndexOf(read);
  return at < 0 ? whole : `${whole.slice(0, at)}new URLSearchParams(${JSON.stringify(asked.toString())})${whole.slice(at + read.length)}`;
}

/** One web view's talk: what its runtime said, the words last picked in it, and the way to send it a command. */
export interface Frame {
  readonly shown: Accessor<Shown>;
  readonly picked: Accessor<HtmlAnchor | undefined>;
  /** The page loaded (onLoad), or why it did not (onError). */
  readonly state: Accessor<"loading" | "loaded" | { readonly error: string }>;
  readonly send: (command: HtmlShellCommand) => void;
  readonly heard: (data: string) => void;
  readonly setRef: (ref: WebViewRef | undefined) => void;
  readonly setState: (state: "loading" | "loaded" | { readonly error: string }) => void;
}

/** What a frame's runtime says, followed: only the protocol's messages (a page can post anything; they are hints). */
export function createFrame(): Frame {
  const shown = signal<Shown>({});
  const picked = signal<HtmlAnchor | undefined>(undefined);
  const state = signal<"loading" | "loaded" | { readonly error: string }>("loading");
  let ref: WebViewRef | undefined;
  return {
    shown,
    picked,
    state,
    send: (command) => ref?.injectJavaScript(`window.postMessage(${JSON.stringify(command)}, "*");`),
    heard: (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      const anchor = selectionOf(parsed);
      if (anchor) return picked.set(anchor);
      const message = shellMessageOf(parsed);
      if (message?.vibevalley === "ready") shown.set({ ...shown(), ready: message });
      if (message?.vibevalley === "at") shown.set({ ...shown(), at: message });
    },
    setRef: (r) => {
      ref = r;
    },
    setState: (s) => state.set(s),
  };
}
