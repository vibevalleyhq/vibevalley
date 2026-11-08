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
  toast: {
    animationName: { default: "pop-in", "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "280ms",
    animationTimingFunction: "var(--ease-out)",
    animationFillMode: "both",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-page)",
    boxShadow: "var(--shadow-float)",
  },
  toastBad: {
    backgroundColor: "var(--color-berry)",
  },
  toastOk: {
    backgroundColor: "var(--color-ink)",
  },
});

/** Draws the toasts (ui/toasts.ts) at the bottom of the page. */
export function ToastHost() {
  return (
    <div {...stylex.attrs(viewStyles.toasts)} role="log" aria-label={t("web.base.toasts")} data-testid="toasts">
      <For each={toasts.get()}>
        {(t) => (
          <div data-testid="toast" data-tone={t.tone} {...stylex.attrs(viewStyles.toast, t.tone === "bad" ? viewStyles.toastBad : viewStyles.toastOk)}>
            {t.text}
          </div>
        )}
      </For>
    </div>
  );
}
