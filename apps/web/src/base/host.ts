// The host the page runs in (@vibevalley/protocol/host): the desktop's preload sets hostKey; the phone's WebView brings
// ReactNativeWebView, and its host is built here, over the bridge; a browser tab has none.

import { type FromNative, fromNativeKey, type Host, hostKey, mobileHost } from "@vibevalley/protocol/host";

/** A browser tab: no host around the page. */
export const browserHost: Host = {
  name: "browser",
};

let phone: Host | undefined;

export function currentHost(): Host {
  const g = globalThis as Record<string, unknown>;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the desktop shell's preload puts a Host here (this file is the contract)
  const given = g[hostKey] as Host | undefined;
  if (given) return given;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- React Native's WebView puts its bridge here
  const native = g.ReactNativeWebView as { postMessage(text: string): void } | undefined;
  if (!native) return browserHost;
  if (!phone) {
    const bridge = mobileHost((m) => native.postMessage(JSON.stringify(m)));
    g[fromNativeKey] = (m: FromNative) => bridge.receive(m);
    phone = bridge.host;
  }
  return phone;
}
