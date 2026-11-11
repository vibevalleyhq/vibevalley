import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createEffect } from "solid-js";

import { Dialog as Base } from "@vibevalley/base-ui";

const popIn = stylex.keyframes({
  from: { opacity: 0, scale: 0.98 },
});

const fadeIn = stylex.keyframes({
  from: { opacity: 0 },
});

const styles = stylex.create({
  popup: {
    margin: "auto",
    animationName: {
      default: popIn,
      "@media (prefers-reduced-motion: reduce)": "none",
      "::backdrop": fadeIn,
    },
    animationDuration: {
      default: "280ms",
      "::backdrop": "180ms",
    },
    animationTimingFunction: {
      default: "var(--ease-out)",
      "::backdrop": "var(--ease-out)",
    },
    animationFillMode: {
      default: "both",
      "::backdrop": "both",
    },
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: {
      default: "var(--wb-page)",
      "::backdrop": "var(--wb-scrim)",
    },
    padding: "0",
    color: "var(--wb-ink)",
    boxShadow: "var(--shadow-float)",
  },
  popupNarrow: {
    width: "min(480px,92vw)",
  },
  popupWide: {
    width: "min(1080px,94vw)",
  },
  frame: {
    display: "flex",
    maxHeight: "86vh",
    flexDirection: "column",
  },
  title: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "1.25rem",
    paddingBlock: "0.75rem",
    fontSize: "var(--text-base)",
    lineHeight: "var(--leading-base)",
    fontWeight: "var(--font-weight-semibold)",
  },
  body: {
    overflowY: "auto",
    paddingInline: "1.25rem",
    paddingBlock: "1rem",
  },
});

/** The native modal <dialog> (the top layer, a focus trap, the page behind inert), shown while `open`. Escape and a click on the backdrop ask onClose. */
export function createModal(open: () => boolean, onClose: () => void) {
  let dialog!: HTMLDialogElement;
  createEffect(open, (on) => {
    if (on && !dialog.open) dialog.showModal();
    if (!on && dialog.open) dialog.close();
  });
  return {
    ref: (el: HTMLDialogElement) => (dialog = el),
    onCancel: (e: Event) => {
      e.preventDefault();
      onClose();
    },
    // A browser may close it without a cancel (Escape pressed twice): the caller still hears of it.
    onClose: () => open() && onClose(),
    onClick: (e: MouseEvent) => e.target === dialog && onClose(),
  };
}

/** A modal over the page (the native <dialog>: focus trap, Escape closes). Open while `open`. */
export function Dialog(props: { open: boolean; onClose: () => void; title: string; children: JSX.Element; wide?: boolean; testid?: string }) {
  return (
    <Base.Root open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Base.Popup data-testid={props.testid} {...stylex.attrs(styles.popup, props.wide === true ? styles.popupWide : styles.popupNarrow)}>
        <div {...stylex.attrs(styles.frame)}>
          <Base.Title {...stylex.attrs(styles.title)}>{props.title}</Base.Title>
          <div {...stylex.attrs(styles.body)}>{props.children}</div>
        </div>
      </Base.Popup>
    </Base.Root>
  );
}
