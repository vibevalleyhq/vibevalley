import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { createModal } from "#/ui/Dialog.tsx";

import { DashedLine } from "./base";
import { PxButton } from "./button";
import { SpriteIcon } from "./icons";
import { pxFocus, pxText, pxWindow } from "./style";

const viewStyles = stylex.create({
  farmDialogDiv: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    backgroundColor: "var(--color-cream-100)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 2.5)",
  },
  farmDialogDiv2: {
    flexShrink: "0",
    backgroundColor: "var(--color-cream-100)",
  },
  farmDialogDiv3: {
    minHeight: "0",
    flex: "1",
    overflowY: "auto",
    padding: "calc(var(--spacing) * 4)",
  },
  farmSectionSection: {
    display: "flex",
    flexDirection: "column",
    paddingTop: "calc(var(--spacing) * 4)",
  },
  pxDialogDiv: {
    marginBottom: "calc(var(--spacing) * 5)",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
  },
});

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
      style={props.style}
      class={[
        "m-auto max-h-none max-w-none overflow-visible bg-cream-50 p-0 text-bark-900",
        pxWindow,
        "transition-[opacity,scale] duration-150 motion-reduce:transition-none starting:scale-95 starting:opacity-0",
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
      backdrop="backdrop:bg-bark-900/30"
      class={farmSizes[props.size]}
    >
      <div class={[pxText.sm, "flex h-full flex-col overflow-hidden"]}>
        <div {...stylex.attrs(viewStyles.farmDialogDiv)}>
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
        <div {...stylex.attrs(viewStyles.farmDialogDiv2)}>
          <DashedLine />
        </div>
        <div {...stylex.attrs(viewStyles.farmDialogDiv3)}>{props.children}</div>
      </div>
    </Modal>
  );
}

export function FarmSection(props: { title: string; children?: JSX.Element }) {
  return (
    <section {...stylex.attrs(viewStyles.farmSectionSection)}>
      <h3 class={[pxText.xs, "mb-1.5 text-bark-600"]}>{props.title}</h3>
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
      backdrop="backdrop:bg-px-scrim"
      class="w-[min(512px,calc(100vw-32px))] border-2 border-bark-500"
    >
      <div class={[pxText.sm, "max-h-[85dvh] overflow-y-auto p-6"]}>
        <div {...stylex.attrs(viewStyles.pxDialogDiv)}>
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
