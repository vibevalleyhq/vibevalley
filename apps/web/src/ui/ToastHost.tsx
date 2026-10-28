import { t } from "@vibevalley/i18n";

import { For } from "solid-js";
import { toasts } from "./toasts";
import { createExternal } from "../base/external";

/** Draws the toasts (ui/toasts.ts) at the bottom of the page. */
export function ToastHost() {
  const shown = createExternal(toasts.subscribe, toasts.get);
  return (
    <div
      class="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2"
      role="log"
      aria-label={t("web.base.toasts")}
      data-testid="toasts"
    >
      <For each={shown()}>
        {(t) => (
          <div
            data-testid="toast"
            data-tone={t.tone}
            class={["rounded-md px-3 py-1.5 text-sm text-page shadow-float", t.tone === "bad" ? "bg-berry" : "bg-ink"]}
          >
            {t.text}
          </div>
        )}
      </For>
    </div>
  );
}
