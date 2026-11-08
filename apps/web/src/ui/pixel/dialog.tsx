import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { createModal } from "#/ui/Dialog.tsx";

import { DashedLine } from "./base";
import { PxButton } from "./button";
import { SpriteIcon } from "./icons";
import { pxFocus, pxWindow } from "./style";

const recipeStyles = stylex.create({
  farmDialogDiv: {
    display: "flex",
    height: "100%",
    flexDirection: "column",
    overflow: "hidden",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.4286",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  farmDialogH2: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-pixel)",
    fontSize: "24px",
    lineHeight: "1.5556",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  farmSectionH3: {
    marginBottom: "calc(var(--spacing) * 1.5)",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.3333",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    color: "var(--color-bark-600)",
    fontSynthesis: "none",
  },
  pxDialogDiv: {
    maxHeight: "85dvh",
    overflowY: "auto",
    padding: "calc(var(--spacing) * 6)",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.4286",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  pxDialogH2: {
    minWidth: "0",
    flex: "1",
    fontFamily: "var(--font-pixel)",
    fontSize: "24px",
    lineHeight: "1.4",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
});

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
      <div {...stylex.attrs(recipeStyles.farmDialogDiv)}>
        <div {...stylex.attrs(viewStyles.farmDialogDiv)}>
          <Show when={props.icon}>{(icon) => <SpriteIcon name={icon()} size={32} />}</Show>
          <h2 {...stylex.attrs(recipeStyles.farmDialogH2)}>{props.title}</h2>
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
      <h3 {...stylex.attrs(recipeStyles.farmSectionH3)}>{props.title}</h3>
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
      <div {...stylex.attrs(recipeStyles.pxDialogDiv)}>
        <div {...stylex.attrs(viewStyles.pxDialogDiv)}>
          <h2 {...stylex.attrs(recipeStyles.pxDialogH2)}>{props.title}</h2>
          <PxButton size="icon" label={t("web.ui.pixel.close")} onClick={() => props.onClose()}>
            <SpriteIcon name="button-close" size={16} />
          </PxButton>
        </div>
        {props.children}
      </div>
    </Modal>
  );
}
