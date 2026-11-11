import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";

import { t } from "@vibevalley/i18n";

import { toasts } from "./toasts";

const popIn = stylex.keyframes({
  from: { opacity: 0, scale: 0.98 },
});

const viewStyles = stylex.create({
  toasts: {
    pointerEvents: "none",
    position: "fixed",
    insetInline: "0",
    bottom: "1rem",
    zIndex: "40",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.5rem",
  },
  toast: {
    animationName: { default: popIn, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "280ms",
    animationTimingFunction: "var(--ease-out)",
    animationFillMode: "both",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.75rem",
    paddingBlock: "0.375rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
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
