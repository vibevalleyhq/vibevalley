// The farm: the page the paired computer serves, in a WebView, with this phone as its host (@vibevalley/host's mobile
// bridge): the page posts what it asks, the shell answers by id and sends the call's events back.

import { type ComponentType, type Ref, useRef } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import { type FromNative, fromNativeKey, type ToNative } from "@vibevalley/host";
import type { Farm } from "./farm";
import { notify } from "./notify";
import * as rtc from "./rtc";
import { isPairPage, keyScript } from "./rules";
import { colors } from "./style";

// The package types its props as WebViewProps & P with P = undefined, which is never: the props it takes, as they are.
const Web = WebView as unknown as ComponentType<WebViewProps & { ref?: Ref<WebView<object>> }>;

export function FarmScreen({ farm, forgotten }: { farm: Farm; forgotten: () => void }) {
  const view = useRef<WebView<object>>(null);
  const send = (m: FromNative) => view.current?.injectJavaScript(`window.${fromNativeKey}?.(${JSON.stringify(m)}); true;`);

  const answer = async (m: ToNative) => {
    try {
      switch (m.call) {
        case "notify":
          await notify(m.notice);
          break;
        case "rtc.join":
          await rtc.join(m.grant, send);
          break;
        case "rtc.mute":
          rtc.mute(m.on);
          break;
        case "rtc.renew":
          rtc.renew(m.token);
          break;
        case "rtc.leave":
          rtc.leave();
          break;
      }
      send({ id: m.id, ok: true });
    } catch (e) {
      send({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const onMessage = (e: WebViewMessageEvent) => {
    let m: ToNative;
    try {
      m = JSON.parse(e.nativeEvent.data) as ToNative;
    } catch {
      return;
    }
    void answer(m);
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
        onMessage={onMessage}
        // The page sends a phone whose key the farm no longer knows to its own pairing: pair again here instead.
        onShouldStartLoadWithRequest={(r) => {
          if (!isPairPage(farm.url, r.url)) return true;
          rtc.leave();
          forgotten();
          return false;
        }}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({ fill: { flex: 1, backgroundColor: colors.page } });
