import { signal, type Accessor, type WebViewRef } from "nsh";

import type { HtmlAnchor, HtmlShellCommand, HtmlShellMessage } from "@vibevalley/protocol";

import { type PresenceHighlightCommand, selectionOf, shellMessageOf } from "./shell";

export type { HtmlShellCommand };

/** What the page's runtime last said: what it is (ready), where it is (at), and any recording result. */
export interface Shown {
  readonly ready?: Extract<HtmlShellMessage, { vibevalley: "ready" }>;
  readonly at?: Extract<HtmlShellMessage, { vibevalley: "at" }>;
  readonly recorded?: Extract<HtmlShellMessage, { vibevalley: "recorded" }>;
}

/** Whitelist outgoing HtmlShellMessage and StoreBridgeMessage tags so incoming commands are never echoed back out. */
export const shim = String.raw`(() => {
  const OUT = new Set([
    "selection",
    "ready",
    "at",
    "recorded",
    "store-provenance",
    "store-mark-click",
    "store-params",
    "store-props",
    "store-embed-save",
  ]);
  const out = (d) => {
    window.nsh?.postMessage(JSON.stringify(d));
  };
  addEventListener("message", (e) => {
    const d = e.data;
    if (e.source === window && d && typeof d === "object" && typeof d.vibevalley === "string" && OUT.has(d.vibevalley)) out(d);
  });
})();`;

/** One slide thumbnail, still: a WebView consumes pointer hits over its box, so any click posts `"pick"` back to the host. */
export const pickShim = String.raw`addEventListener("click", (e) => { e.preventDefault(); window.nsh?.postMessage("pick"); }, true);`;

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

/** Prepares a Rust shell-wrapped page for an nsh WebView: injects the CSP meta policy and substitutes `location.search`
 * with the requested slide/still query parameters (a WebView loaded from `html` has no URL query string). */
export function withShellQuery(html: string, opts?: { readonly at?: number; readonly still?: boolean }): string {
  const asked = new URLSearchParams();
  if (opts?.at !== undefined) asked.set("at", String(opts.at));
  if (opts?.still === true) asked.set("still", "1");
  const whole = withPolicy(html);
  // The runtime reads `location.search`, which a page given as html does not have: it reads the asked one instead. The
  // runtime is last in the page, so the last such read is its.
  const read = "new URLSearchParams(location.search)";
  const at = whole.lastIndexOf(read);
  return at < 0 ? whole : `${whole.slice(0, at)}new URLSearchParams(${JSON.stringify(asked.toString())})${whole.slice(at + read.length)}`;
}

/** One web view's talk: what its runtime said, the words last picked in it, and the way to send it a command. */
export interface Frame {
  readonly shown: Accessor<Shown>;
  readonly picked: Accessor<(HtmlAnchor & { readonly path?: string }) | undefined>;
  /** The page loaded (onLoad), or why it did not (onError). */
  readonly state: Accessor<"loading" | "loaded" | { readonly error: string }>;
  readonly send: (command: HtmlShellCommand | PresenceHighlightCommand | Record<string, unknown>) => void;
  readonly heard: (data: string) => void;
  readonly onMessage: (listener: (raw: unknown) => void) => () => void;
  readonly setRef: (ref: WebViewRef | undefined) => void;
  readonly setState: (state: "loading" | "loaded" | { readonly error: string }) => void;
}

/** What a frame's runtime says, followed: only whitelisted protocol messages (a page can post anything; they are hints). */
export function createFrame(): Frame {
  const shown = signal<Shown>({});
  const picked = signal<(HtmlAnchor & { readonly path?: string }) | undefined>(undefined);
  const state = signal<"loading" | "loaded" | { readonly error: string }>("loading");
  const listeners = new Set<(raw: unknown) => void>();
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
      for (const fn of listeners) fn(parsed);
      const message = shellMessageOf(parsed);
      if (!message) return;
      switch (message.vibevalley) {
        case "selection": {
          const anchor = selectionOf(parsed);
          if (anchor) picked.set(message.path !== undefined ? { ...anchor, path: message.path } : anchor);
          return;
        }
        case "ready":
          shown.set({ ...shown(), ready: message });
          return;
        case "at":
          shown.set({ ...shown(), at: message });
          return;
        case "recorded":
          shown.set({ ...shown(), recorded: message });
          return;
      }
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setRef: (r) => {
      ref = r;
    },
    setState: (s) => state.set(s),
  };
}
