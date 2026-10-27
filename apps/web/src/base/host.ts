// The host the page runs in (@vibevalley/protocol/host): the desktop's preload sets hostKey; the phone's WebView brings
// ReactNativeWebView, and its host is built here, over the bridge; a browser tab has none.

import { type FromNative, fromNativeKey, type Host, hostKey, mobileHost } from "@vibevalley/protocol/host";

/** A browser tab: no host around the page. */
export const browserHost: Host = { name: "browser", notify: null, tray: null, voiceShortcut: null, rtc: null, titleBar: null, locale: null };

let phone: Host | undefined;

export function currentHost(): Host {
  const g = globalThis as Record<string, unknown>;
  const given = g[hostKey] as Host | undefined;
  if (given) return given;
  const native = g.ReactNativeWebView as { postMessage(text: string): void } | undefined;
  if (!native) return browserHost;
  if (!phone) {
    const bridge = mobileHost((m) => native.postMessage(JSON.stringify(m)));
    g[fromNativeKey] = (m: FromNative) => bridge.receive(m);
    phone = bridge.host;
  }
  return phone;
}
