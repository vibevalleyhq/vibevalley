import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { createModal } from "#/ui/Dialog.tsx";
import { styleProps } from "#/ui/positioner.ts";

import { DashedLine } from "./base";
import { PxButton } from "./button";
import { SpriteIcon } from "./icons";
import { pxStyle } from "./style";

const viewStyles = stylex.create({
  close: {
    display: "grid",
    width: "2.25rem",
    height: "2.25rem",
    flexShrink: 0,
    cursor: "pointer",
    placeItems: "center",
    backgroundColor: { default: null, "@media (hover:hover)": { default: null, ":hover": "var(--color-cream-200)" } },
  },
  closeIcon: {
    translate: { default: null, [stylex.when.ancestor(":active")]: "1px 1px" },
  },
  modal: {
    margin: "auto",
    maxHeight: "none",
    maxWidth: "none",
    overflow: "visible",
    backgroundColor: "var(--color-cream-50)",
    padding: 0,
    color: "var(--color-bark-900)",
    transitionProperty: { default: "opacity,scale", "@media (prefers-reduced-motion: reduce)": "none" },
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: "150ms",
    scale: { default: null, "@starting-style": "95% 95%" },
    opacity: { default: null, "@starting-style": 0 },
  },
  farmBackdrop: {
    backgroundColor: {
      default: "var(--color-cream-50)",
      "::backdrop": {
        default: "var(--color-px-dialog-backdrop)",
        "@supports (color: color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-bark-900) 30%, transparent)",
      },
    },
  },
  settingsBackdrop: { backgroundColor: { default: "var(--color-cream-50)", "::backdrop": "var(--color-px-scrim)" } },
  settingsSize: { width: "min(512px,calc(100vw - 32px))", borderWidth: 2, borderStyle: "solid", borderColor: "var(--color-bark-500)" },
  farmDialogRoot: {
    display: "flex",
    height: "100%",
    flexDirection: "column",
    overflow: "hidden",
  },
  farmDialogHeader: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: "0.5rem",
    backgroundColor: "var(--color-cream-100)",
    paddingInline: "1rem",
    paddingBlock: "0.625rem",
  },
  farmDialogTitle: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  farmDialogRule: {
    flexShrink: "0",
    backgroundColor: "var(--color-cream-100)",
  },
  farmDialogBody: {
    minHeight: "0",
    flex: "1",
    overflowY: "auto",
    padding: "1rem",
  },
  farmSection: {
    display: "flex",
    flexDirection: "column",
    paddingTop: "1rem",
  },
  farmSectionTitle: {
    marginBottom: "0.375rem",
    color: "var(--color-bark-600)",
  },
  pxDialogRoot: {
    maxHeight: "85dvh",
    overflowY: "auto",
    padding: "1.5rem",
  },
  pxDialogHeader: {
    marginBottom: "1.25rem",
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
  },
  pxDialogTitle: {
    minWidth: "0",
    flex: "1",
  },
});

function Modal(props: {
  open: boolean;
  onClose: () => void;
  label: string;
  testid?: string | undefined;
  backdrop: stylex.StyleXStyles;
  styles: stylex.StyleXStyles;
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
      {...styleProps([viewStyles.modal, pxStyle.window, props.backdrop, props.styles], props.style)}
    >
      <Show when={props.open}>{props.children}</Show>
    </dialog>
  );
}

const farmSizes = stylex.create({
  sm: { width: "min(480px,calc(100vw - 24px))", height: "min(384px,88dvh)" },
  md: { width: "min(480px,calc(100vw - 24px))", height: "min(608px,88dvh)" },
  lg: { width: "min(736px,calc(100vw - 24px))", height: "min(576px,88dvh)" },
  wide: { width: "min(720px,calc(100vw - 24px))", height: "min(608px,88dvh)" },
});

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
      backdrop={viewStyles.farmBackdrop}
      styles={farmSizes[props.size]}
    >
      <div {...stylex.attrs(pxStyle.sm, viewStyles.farmDialogRoot)}>
        <div {...stylex.attrs(viewStyles.farmDialogHeader)}>
          <Show when={props.icon}>{(icon) => <SpriteIcon name={icon()} size={32} />}</Show>
          <h2 {...stylex.attrs(pxStyle.lg, viewStyles.farmDialogTitle)}>{props.title}</h2>
          <button
            type="button"
            aria-label={t("web.ui.pixel.close")}
            onClick={() => props.onClose()}
            {...stylex.attrs(viewStyles.close, pxStyle.focus, stylex.defaultMarker())}
          >
            <SpriteIcon name="button-close" size={18} styles={viewStyles.closeIcon} />
          </button>
        </div>
        <div {...stylex.attrs(viewStyles.farmDialogRule)}>
          <DashedLine />
        </div>
        <div {...stylex.attrs(viewStyles.farmDialogBody)}>{props.children}</div>
      </div>
    </Modal>
  );
}

export function FarmSection(props: { title: string; children?: JSX.Element }) {
  return (
    <section {...stylex.attrs(viewStyles.farmSection)}>
      <h3 {...stylex.attrs(pxStyle.xs, viewStyles.farmSectionTitle)}>{props.title}</h3>
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
      backdrop={viewStyles.settingsBackdrop}
      styles={viewStyles.settingsSize}
    >
      <div {...stylex.attrs(pxStyle.sm, viewStyles.pxDialogRoot)}>
        <div {...stylex.attrs(viewStyles.pxDialogHeader)}>
          <h2 {...stylex.attrs(pxStyle.xl, viewStyles.pxDialogTitle)}>{props.title}</h2>
          <PxButton size="icon" label={t("web.ui.pixel.close")} onClick={() => props.onClose()}>
            <SpriteIcon name="button-close" size={16} />
          </PxButton>
        </div>
        {props.children}
      </div>
    </Modal>
  );
}
