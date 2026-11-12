import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { createModal } from "#/ui/Dialog.tsx";

import { DashedLine } from "./base";
import { PxButton } from "./button";
import { SpriteIcon } from "./icons";

const farmBackdrop = "bg-cream-50 backdrop:bg-bark-900/30";
const settingsBackdrop = "bg-cream-50 backdrop:bg-px-scrim";

function Modal(props: {
  open: boolean;
  onClose: () => void;
  label: string;
  testid?: string | undefined;
  backdrop: string;
  class: string;
  style?: JSX.CSSProperties;
  children: JSX.Element;
}) {
  const m = createModal(
    () => props.open,
    () => props.onClose(),
  );
  return (
    <dialog
      ref={m.ref}
      aria-label={props.label}
      data-testid={props.testid}
      onCancel={m.onCancel}
      onClose={m.onClose}
      onClick={m.onClick}
      class={[
        "m-auto max-h-none max-w-none overflow-visible p-0 text-bark-900 transition-[opacity,scale] duration-150 ease-out pixel-window starting:scale-95 starting:opacity-0 motion-reduce:transition-none",
        props.backdrop,
        props.class,
      ]}
      style={props.style}
    >
      <Show when={props.open}>{props.children}</Show>
    </dialog>
  );
}

export type FarmDialogSize = "sm" | "md" | "lg" | "wide";

const farmSizes: Record<FarmDialogSize, string> = {
  sm: "w-[min(480px,calc(100vw_-_24px))] h-[min(384px,88dvh)]",
  md: "w-[min(480px,calc(100vw_-_24px))] h-[min(608px,88dvh)]",
  lg: "w-[min(736px,calc(100vw_-_24px))] h-[min(576px,88dvh)]",
  wide: "w-[min(720px,calc(100vw_-_24px))] h-[min(608px,88dvh)]",
};

/** A farm panel's frame: whatever it holds, it keeps its size and scrolls inside. Shown while `open` (default) is true. */
export function FarmDialog(props: {
  title: string;
  size: FarmDialogSize;
  icon?: string;
  open?: boolean;
  testid?: string;
  onClose: () => void;
  children?: JSX.Element;
}) {
  return (
    <Modal
      open={props.open ?? true}
      onClose={() => props.onClose()}
      label={props.title}
      testid={props.testid}
      backdrop={farmBackdrop}
      class={farmSizes[props.size]}
    >
      <div class="flex h-full flex-col overflow-hidden pixel-sm">
        <div class="flex shrink-0 items-center gap-2 bg-cream-100 px-4 py-2.5">
          <Show when={props.icon}>{(icon) => <SpriteIcon name={icon()} size={32} />}</Show>
          <h2 class="min-w-0 flex-1 truncate pixel-lg">{props.title}</h2>
          <button
            type="button"
            aria-label={t("web.ui.pixel.close")}
            onClick={() => props.onClose()}
            class="group grid size-9 shrink-0 cursor-pointer place-items-center pixel-focus hover:bg-cream-200"
          >
            <SpriteIcon name="button-close" size={18} class="group-active:translate-px" />
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
      <h3 class="mb-1.5 text-bark-600 pixel-xs">{props.title}</h3>
      {props.children}
    </section>
  );
}

/** A settings dialog: at most 512 px wide, as tall as it needs up to 85 % of the screen. */
export function PxDialog(props: { title: string; open?: boolean; testid?: string; onClose: () => void; children?: JSX.Element }) {
  return (
    <Modal
      open={props.open ?? true}
      onClose={() => props.onClose()}
      label={props.title}
      testid={props.testid}
      backdrop={settingsBackdrop}
      class="w-[min(512px,calc(100vw_-_32px))] border-2 border-bark-500"
    >
      <div class="max-h-[85dvh] overflow-y-auto p-6 pixel-sm">
        <div class="mb-5 flex items-center gap-3">
          <h2 class="min-w-0 flex-1 pixel-xl">{props.title}</h2>
          <PxButton size="icon" label={t("web.ui.pixel.close")} onClick={() => props.onClose()}>
            <SpriteIcon name="button-close" size={16} />
          </PxButton>
        </div>
        {props.children}
      </div>
    </Modal>
  );
}
