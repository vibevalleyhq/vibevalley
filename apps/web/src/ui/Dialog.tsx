import type { JSX } from "@solidjs/web";

import { Dialog as Base } from "@vibevalley/base-ui";

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
