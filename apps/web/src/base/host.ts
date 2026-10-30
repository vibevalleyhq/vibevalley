// The host the page runs in (@vibevalley/protocol/host): the desktop's preload sets hostKey; the phone's WebView brings
// ReactNativeWebView, and its host is built here, over the bridge; a browser tab has none.

import type { Link } from "@vibevalley/bridge";
import { fromNativeKey, type Host, hostKey, mobileHost } from "@vibevalley/protocol/host";

/** A browser tab: no host around the page. */
export const browserHost: Host = {
  name: "browser",
};

let phone: Host | undefined;

/** The page's end of the phone's bridge: it posts text, and the shell calls fromNativeKey with each message. */
function webViewLink(native: { postMessage(text: string): void }, g: Record<string, unknown>): Link {
  const ears = new Set<(m: unknown) => void>();
  g[fromNativeKey] = (m: unknown) => {
    for (const fn of ears) fn(m);
  };
  return {
    send: (m) => native.postMessage(JSON.stringify(m)),
    receive: (fn) => {
      ears.add(fn);
      return () => void ears.delete(fn);
    },
  };
}

export function currentHost(): Host {
  const g = globalThis as Record<string, unknown>;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the desktop shell's preload puts a Host here (this file is the contract)
  const given = g[hostKey] as Host | undefined;
  if (given) return given;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- React Native's WebView puts its bridge here
  const native = g.ReactNativeWebView as { postMessage(text: string): void } | undefined;
  if (!native) return browserHost;
  phone ??= mobileHost(webViewLink(native, g));
  return phone;
}
