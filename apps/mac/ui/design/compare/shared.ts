import { computed } from "nsh";

import { t } from "@vibevalley/i18n";

import type { CompareAnnotationSide, CompareAnnotationTone, CompareImage } from "../compareModel";
import { fileUrl, useDesignHost } from "../host";

export type CompareMode = "side" | "slider";
export type OverlaySide = "before" | "after" | "single";
type SemanticToken = "berry" | "leaf" | "water";

export const SPLIT_PRESETS = [25, 50, 75] as const;

export function annotationToken(kind: CompareAnnotationTone | undefined): SemanticToken {
  switch (kind) {
    case "issue":
      return "berry";
    case "fixed":
      return "leaf";
    case "note":
    case undefined:
      return "water";
  }
}

export function sideLabel(side: CompareAnnotationSide | undefined): string {
  switch (side) {
    case "before":
      return t("web.base.compare.before");
    case "after":
      return t("web.base.compare.after");
    case "both":
    case undefined:
      return t("web.base.compare.sideBoth");
  }
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function defaultAnnotationRect(index: number): [number, number, number, number] {
  const row = index % 4;
  const col = Math.floor(index / 4) % 2;
  const x = Number((0.08 + col * 0.44).toFixed(2));
  const y = Number((0.1 + row * 0.2).toFixed(2));
  return [x, y, 0.36, 0.16];
}

export function useResolvedImage(image: () => CompareImage | undefined) {
  const file = useDesignHost().useAttachmentFile(() => image()?.attachment ?? "");
  const src = computed(() => {
    const img = image();
    if (!img) return undefined;
    if (img.url !== undefined && img.url !== "") return img.url;
    const f = file();
    return f ? fileUrl(f.path) : undefined;
  });
  const path = computed(() => file()?.path);
  return { src, path };
}
