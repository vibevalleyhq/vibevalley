import { Overlay, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { toasts } from "./toasts";

export function ToastHost() {
  const list = () => toasts.get();
  return (
    <If when={list().length > 0}>
      <Overlay style={{ left: 0, right: 0, bottom: 16, alignItems: "center", pointerEvents: "box-none" }}>
        <View accessibilityLabel={t("web.base.toasts")} testID="toasts" class="items-center gap-2">
          <Each of={list()}>
            {(toast) => (
              <View testID="toast" class={`rounded-md px-3 py-1.5 shadow-float ${toast().tone === "bad" ? "bg-berry" : "bg-ink"}`}>
                <Text class="text-sm text-page">{toast().text}</Text>
              </View>
            )}
          </Each>
        </View>
      </Overlay>
    </If>
  );
}
