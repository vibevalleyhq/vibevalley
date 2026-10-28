import { t } from "@vibevalley/i18n";

import { createEffect, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { pxFocus, pxText, pxWindow } from "./style";
import { DashedLine } from "./base";
import { PxButton } from "./button";
import { SpriteIcon } from "./icons";

// The native modal dialog: the top layer, a focus trap and inert page behind. Escape and a click on the backdrop ask
// onClose; the dialog stays open until `open` turns false, so the caller owns it.
function Modal(props: {
  open: boolean;
  onClose: () => void;
  label: string;
  backdrop: string;
  class: string;
  style?: JSX.CSSProperties;
  children: JSX.Element;
}) {
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
      aria-label={props.label}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
      // A browser may close it without a cancel (Escape pressed twice): the caller still hears of it.
      onClose={() => props.open && props.onClose()}
      onClick={(e) => e.target === dialog && props.onClose()}
      style={props.style}
      class={[
        "m-auto max-h-none max-w-none overflow-visible bg-cream-50 p-0 text-bark-900",
        pxWindow,
        "transition-[opacity,scale] duration-150 starting:scale-95 starting:opacity-0 motion-reduce:transition-none",
        props.backdrop,
        props.class,
      ]}
    >
      <Show when={props.open}>{props.children}</Show>
    </dialog>
  );
}

const farmSizes = {
  sm: "w-[min(480px,calc(100vw-24px))] h-[min(384px,88dvh)]",
  md: "w-[min(480px,calc(100vw-24px))] h-[min(608px,88dvh)]",
  lg: "w-[min(736px,calc(100vw-24px))] h-[min(576px,88dvh)]",
  wide: "w-[min(720px,calc(100vw-24px))] h-[min(608px,88dvh)]",
} as const;

export type FarmDialogSize = keyof typeof farmSizes;

/** A farm panel's frame: whatever it holds, it keeps its size and scrolls inside. Shown while `open` (default) is true. */
export function FarmDialog(props: { title: string; size: FarmDialogSize; icon?: string; open?: boolean; onClose: () => void; children?: JSX.Element }) {
  return (
    <Modal open={props.open ?? true} onClose={() => props.onClose()} label={props.title} backdrop="backdrop:bg-bark-900/30" class={farmSizes[props.size]}>
      <div class={[pxText.sm, "flex h-full flex-col overflow-hidden"]}>
        <div class="flex shrink-0 items-center gap-2 bg-cream-100 px-4 py-2.5">
          <Show when={props.icon}>{(icon) => <SpriteIcon name={icon()} size={32} />}</Show>
          <h2 class={[pxText.lg, "min-w-0 flex-1 truncate"]}>{props.title}</h2>
          <button
            type="button"
            aria-label={t("web.ui.pixel.close")}
            onClick={() => props.onClose()}
            class={["group grid size-9 shrink-0 cursor-pointer place-items-center hover:bg-cream-200", pxFocus]}
          >
            <SpriteIcon name="button-close" size={18} class="group-active:translate-x-px group-active:translate-y-px" />
          </button>
        </div>
        <div class="shrink-0 bg-cream-100">
          <DashedLine />
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-4">{props.children}</div>
      </div>
    </Modal>
  );
}

export function FarmSection(props: { title: string; children?: JSX.Element }) {
  return (
    <section class="flex flex-col pt-4">
      <h3 class={[pxText.xs, "mb-1.5 text-bark-600"]}>{props.title}</h3>
      {props.children}
    </section>
  );
}

/** A settings dialog: at most 512 px wide, as tall as it needs up to 85 % of the screen. */
export function PxDialog(props: { title: string; open?: boolean; onClose: () => void; children?: JSX.Element }) {
  return (
    <Modal
      open={props.open ?? true}
      onClose={() => props.onClose()}
      label={props.title}
      backdrop="backdrop:bg-px-scrim"
      class="w-[min(512px,calc(100vw-32px))] border-2 border-bark-500"
    >
      <div class={[pxText.sm, "max-h-[85dvh] overflow-y-auto p-6"]}>
        <div class="mb-5 flex items-center gap-3">
          <h2 class={[pxText.xl, "min-w-0 flex-1"]}>{props.title}</h2>
          <PxButton size="icon" label={t("web.ui.pixel.close")} onClick={() => props.onClose()}>
            <SpriteIcon name="button-close" size={16} />
          </PxButton>
        </div>
        {props.children}
      </div>
    </Modal>
  );
}
