import type { JSX } from "@solidjs/web";
import { createEffect } from "solid-js";

import { Dialog as Base } from "@vibevalley/base-ui";

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

/** A modal over the page (the native <dialog>: focus trap, Escape closes). Open while `open`. */
export function Dialog(props: { open: boolean; onClose: () => void; title: string; children: JSX.Element; wide?: boolean; testid?: string }) {
  return (
    <Base.Root open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <Base.Popup
        data-testid={props.testid}
        class={[
          "m-auto animate-pop-in rounded-lg border border-line bg-page p-0 text-ink shadow-float backdrop:animate-fade-in backdrop:bg-scrim",
          props.wide === true ? "w-[min(1080px,94vw)]" : "w-[min(480px,92vw)]",
        ]}
      >
        <div class="flex max-h-[86vh] flex-col">
          <Base.Title class="border-b border-line px-5 py-3 text-base font-semibold">{props.title}</Base.Title>
          <div class="overflow-y-auto px-5 py-4">{props.children}</div>
        </div>
      </Base.Popup>
    </Base.Root>
  );
}
