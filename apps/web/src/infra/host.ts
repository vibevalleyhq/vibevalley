import type { Link } from "@vibevalley/bridge";
import { type Host, mobileHost } from "@vibevalley/protocol/host";

/** A browser tab: no host around the page. */
const browserHost: Host = {
  name: "browser",
};

let phone: Host | undefined;

function webViewLink(native: { postMessage(text: string): void }): Link {
  const ears = new Set<(m: unknown) => void>();
  window.vibevalleyFromHost = (m) => {
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
  const given = window.vibevalleyHost;
  if (given) return given;
  const native = window.ReactNativeWebView;
  if (!native) return browserHost;
  phone ??= mobileHost(webViewLink(native));
  return phone;
}
