import { Scroll, Text, View, windowSize, type JSX } from "nsh";
import { Dialog as Base } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { IconButton } from "./IconButton";
import { fadeAnimation } from "./motion";

export type DialogSize = "sm" | "md" | "lg" | "xl";
export type DialogHeight = "auto" | "fixed";

export interface DialogDimensions {
  readonly width: number;
  readonly height?: number;
  readonly maxHeight?: number;
  readonly marginTop: number;
}

interface DialogSpec {
  readonly width: number;
  readonly fixedHeight: number;
  readonly maxHeight: number;
  readonly gutterX: number;
  readonly heightRatio: number;
}

const DIALOG_SPECS: Record<DialogSize, DialogSpec> = {
  sm: { width: 480, fixedHeight: 440, maxHeight: 560, gutterX: 32, heightRatio: 0.8 },
  md: { width: 640, fixedHeight: 540, maxHeight: 620, gutterX: 32, heightRatio: 0.8 },
  lg: { width: 820, fixedHeight: 640, maxHeight: 680, gutterX: 32, heightRatio: 0.82 },
  xl: { width: 1000, fixedHeight: 680, maxHeight: 720, gutterX: 48, heightRatio: 0.82 },
};

/** Computes bounded modal width, height, and consistent top Y anchor from size tier, height mode, and viewport. */
export function dialogDimensions(size: DialogSize, height: DialogHeight, viewport: { width: number; height: number }): DialogDimensions {
  const spec = DIALOG_SPECS[size];
  const width = Math.min(spec.width, Math.max(240, Math.round(viewport.width - spec.gutterX)));
  const marginTop = Math.max(24, Math.min(80, Math.round(viewport.height * 0.09)));
  const bottomGutter = Math.max(24, Math.min(48, Math.round(viewport.height * 0.06)));
  const maxViewportHeight = Math.max(220, Math.min(Math.round(viewport.height * spec.heightRatio), viewport.height - marginTop - bottomGutter));
  if (height === "fixed") {
    return { width, height: Math.min(spec.fixedHeight, maxViewportHeight), marginTop };
  }
  return { width, maxHeight: Math.min(spec.maxHeight, maxViewportHeight), marginTop };
}

/** A modal over the page. Open while `open`. */
export function Dialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: JSX.Element;
  size?: DialogSize;
  height?: DialogHeight;
  scroll?: boolean;
  toolbar?: JSX.Element;
  footer?: JSX.Element;
  bodyClass?: string;
  testid?: string;
}) {
  const heightMode = (): DialogHeight => props.height ?? "auto";
  const isFixed = () => heightMode() === "fixed";
  const dims = () => dialogDimensions(props.size ?? "sm", heightMode(), windowSize());
  return (
    <Base
      open={props.open}
      testID={props.testid}
      accessibilityLabel={props.title}
      animation={fadeAnimation()}
      onOpenChange={(e) => !e.open && props.onClose()}
      backdropClass="bg-scrim"
      class="mx-auto flex-col overflow-hidden rounded-lg border border-line bg-elevated shadow-float"
      style={dims()}
    >
      <View class="min-h-12 shrink-0 flex-row items-center justify-between gap-3 border-b border-line py-2.5 pr-3.5 pl-5">
        <Text role="header" class="min-w-0 flex-1 truncate text-base font-semibold text-ink">
          {props.title}
        </Text>
        <IconButton icon="close" size={14} label={t("web.base.lightbox.close")} onClick={() => props.onClose()} />
      </View>
      <If when={props.toolbar !== undefined}>
        <View class="shrink-0 border-b border-line px-5 py-3">{props.toolbar}</View>
      </If>
      <If when={props.scroll !== false} else={<View class={`min-h-0 ${isFixed() ? "flex-1" : "shrink"}`}>{props.children}</View>}>
        <Scroll class={`min-h-0 ${isFixed() ? "flex-1" : "shrink"}`}>
          <View class={props.bodyClass ?? "px-5 py-4"}>{props.children}</View>
        </Scroll>
      </If>
      <If when={props.footer !== undefined}>
        <View class="shrink-0 border-t border-line px-5 py-3">{props.footer}</View>
      </If>
    </Base>
  );
}
