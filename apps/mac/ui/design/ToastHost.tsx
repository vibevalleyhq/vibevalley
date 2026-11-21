import { Overlay, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { toasts } from "./toasts";
import { mix } from "./tone";

export function ToastHost() {
  const list = () => toasts.get();
  return (
    <If when={list().length > 0}>
      <Overlay style={{ left: 0, right: 0, bottom: 16, alignItems: "center", pointerEvents: "box-none" }}>
        <View accessibilityLabel={t("web.base.toasts")} testID="toasts" class="z-40 items-center gap-2 px-4">
          <Each of={list()}>
            {(toast) => (
              <View
                testID="toast"
                class={`max-w-md flex-row items-center rounded-lg border px-3.5 py-2 shadow-float ${toast().tone === "bad" ? "bg-berry" : "bg-ink"}`}
                style={{ borderColor: mix("page", 0.14) }}
              >
                <Text class="min-w-0 text-sm font-medium text-page">{toast().text}</Text>
              </View>
            )}
          </Each>
        </View>
      </Overlay>
    </If>
  );
}
