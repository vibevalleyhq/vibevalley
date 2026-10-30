// The farm: the page the paired computer serves, in a WebView, with this phone as its host (@vibevalley/protocol/host's
// mobileBridge): the page posts what it asks as text, and the shell answers and pushes by calling fromNativeKey in it.

import { type ComponentType, type Ref, useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent, type WebViewProps } from "react-native-webview";

import type { Link } from "@vibevalley/bridge";
import { fromNativeKey } from "@vibevalley/protocol/host";

import type { Farm } from "./farm";
import { nativeHost } from "./host";
import { isPairPage, keyScript } from "./pairing";
import { colors } from "./style";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the package types its props as WebViewProps & P with P = undefined, which is never: the props it takes, as they are
const Web = WebView as unknown as ComponentType<WebViewProps & { ref?: Ref<WebView<object>> }>;

export function FarmScreen({ farm, forgotten }: { farm: Farm; forgotten: () => void }) {
  const view = useRef<WebView<object>>(null);
  const ears = useRef(new Set<(m: unknown) => void>());
  const link = useRef<Link>({
    send: (m) => view.current?.injectJavaScript(`window.${fromNativeKey}?.(${JSON.stringify(m)}); true;`),
    receive: (fn) => {
      ears.current.add(fn);
      return () => void ears.current.delete(fn);
    },
  });
  const bridge = useRef<ReturnType<typeof nativeHost> | null>(null);
  bridge.current ??= nativeHost(link.current);
  useEffect(() => () => bridge.current?.close(), []);

  const onMessage = (e: WebViewMessageEvent) => {
    let m: unknown;
    try {
      m = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    for (const fn of ears.current) fn(m);
  };

  return (
    <SafeAreaView style={s.fill} edges={["top", "bottom"]}>
      <Web
        ref={view}
        style={s.fill}
        source={{ uri: farm.url + "/", headers: { Authorization: "Bearer " + farm.key } }}
        injectedJavaScriptBeforeContentLoaded={keyScript(farm.key)}
        sharedCookiesEnabled
        // Only an end-to-end build (scripts/e2e.ts) lets adb's DevTools into the page.
        webviewDebuggingEnabled={process.env.EXPO_PUBLIC_VIBEVALLEY_E2E === "1"}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        onLoadStart={() => {
          bridge.current?.close();
          bridge.current = nativeHost(link.current);
        }}
        onMessage={onMessage}
        // The page sends a phone whose key the farm no longer knows to its own pairing: pair again here instead.
        onShouldStartLoadWithRequest={(r) => {
          if (!isPairPage(farm.url, r.url)) return true;
          bridge.current?.close();
          forgotten();
          return false;
        }}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({ fill: { flex: 1, backgroundColor: colors.page } });
