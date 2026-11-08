import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";

import { t } from "@vibevalley/i18n";

import { toasts } from "./toasts";

const viewStyles = stylex.create({
  toasts: {
    pointerEvents: "none",
    position: "fixed",
    insetInline: "0",
    bottom: "calc(var(--spacing) * 4)",
    zIndex: "40",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
});

/** Draws the toasts (ui/toasts.ts) at the bottom of the page. */
export function ToastHost() {
  return (
    <div {...stylex.attrs(viewStyles.toasts)} role="log" aria-label={t("web.base.toasts")} data-testid="toasts">
      <For each={toasts.get()}>
        {(t) => (
          <div
            data-testid="toast"
            data-tone={t.tone}
            class={["animate-pop-in rounded-md px-3 py-1.5 text-sm text-page shadow-float", t.tone === "bad" ? "bg-berry" : "bg-ink"]}
          >
            {t.text}
          </div>
        )}
      </For>
    </div>
  );
}
