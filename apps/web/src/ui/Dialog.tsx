import { createEffect, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

/** A modal over the page (the native <dialog>: focus trap, Escape closes). Open while `open`. */
export function Dialog(props: { open: boolean; onClose: () => void; title: string; children: JSX.Element; wide?: boolean }) {
  let dialog!: HTMLDialogElement;
  createEffect(
    () => props.open,
    (open) => {
      if (open && !dialog.open) dialog.showModal();
      if (!open && dialog.open) dialog.close();
    },
  );
  return (
    <dialog
      ref={(el) => (dialog = el)}
      aria-label={props.title}
      onClose={() => props.onClose()}
      onClick={(e) => e.target === dialog && props.onClose()}
      class={[
        "m-auto rounded-lg border border-line bg-page p-0 text-ink shadow-float backdrop:bg-[#2f1f1340]",
        props.wide ? "w-[min(1080px,94vw)]" : "w-[min(480px,92vw)]",
      ]}
    >
      <Show when={props.open}>
        <div class="flex max-h-[86vh] flex-col">
          <div class="border-b border-line px-5 py-3 text-base font-semibold">{props.title}</div>
          <div class="overflow-y-auto px-5 py-4">{props.children}</div>
        </div>
      </Show>
    </dialog>
  );
}
