import { createEffect } from "solid-js";

/**
 * The native modal <dialog> (the top layer, a focus trap, the page behind inert), shown while `open`. Escape and a click
 * on the backdrop ask onClose; the dialog stays open until `open` turns false, so the caller owns it. Every modal in
 * both skins goes through this, so they close the same way.
 */
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
